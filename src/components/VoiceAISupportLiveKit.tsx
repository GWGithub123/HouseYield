import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVoiceCommand } from '../contexts/VoiceCommandContext';
import { useScreenContext, formatScreenContextForAI } from '../hooks/useScreenContext';
import { useAuth } from '../contexts/AuthContext';
import { getAssets } from '../services/portfolioService';
import { getOwnerFinanceHeaders } from '../services/ownerFinanceApi';
import { fetchAssistantCanonicalContext } from '../services/assistantCanonicalContextService';
import { requestAssistantDataLookup } from '../services/assistantDataLookupService';
import { requestAssistantComputedAnalytics } from '../services/assistantComputedAnalyticsClient';
import { requestAssistantGoogleSearch } from '../services/assistantGoogleSearchService';
import { emitAssistantActionProgress } from '../services/websiteControlService';
import {
  ASSISTANT_MEMORY_FLUSH_MESSAGE_INTERVAL,
  buildAssistantMemorySnapshot,
  formatAssistantMemoryForPrompt,
  getAssistantMemory,
  hasImmediateAssistantMemorySignal,
  setAssistantMemory,
} from '../services/assistantMemoryService';
import {
  clearStoredVoiceFinancialUnlock,
  enrollVoiceIdentitySample,
  getVoiceIdentityStatus,
  isVoiceFinancialUnlockActive,
  readStoredVoiceFinancialUnlock,
  resetVoiceIdentityEnrollment,
  verifyBiometricFinancialUnlock,
  verifyVoiceIdentitySample,
  writeStoredVoiceFinancialUnlock,
  type VoiceFinancialUnlock,
} from '../services/voiceIdentityService';
import { useShellyFirestore } from '../hooks/useShellyFirestore';
import {
  captureMonoWavBase64,
  type MonoWavCaptureResult,
  type PersistentMonoWavCaptureSession,
} from '../utils/voiceAudioCapture';
import type { AssistantMemorySnapshot } from '../types/assistantMemory';
import { AssistantScheduledTasksModal } from './AssistantScheduledTasksModal';
import { listAssistantScheduledTasks } from '../services/assistantScheduledTasksClient';
import { AssistantActivityCenter } from './AssistantActivityCenter';
import { listAssistantNavigablePageKeys, resolveAssistantPageRoute } from '../utils/assistantPageCapabilities';
import { getAssistantExperience } from '../services/assistantExperienceFlags';
import { getDevApiBaseUrl } from '../utils/devApiBase';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

// Sensor data for AI context
interface SensorDataForAI {
  totalSensors: number;
  onlineSensors: number;
  devices: Array<{
    id: string;
    name: string;
    location?: string;
    status: string;
    isFlooded: boolean;
    batteryLevel?: number;
    temperature?: number;
  }>;
  recentAlerts: Array<{
    id: string;
    type: string;
    severity: string;
    message: string;
    timestamp: string;
    deviceName: string;
    acknowledged: boolean;
  }>;
  activeAlertCount: number;
  criticalAlertCount: number;
}

// User data for AI context
interface UserDataForAI {
  properties: Array<{ address: string; value: number }>;
  totalPropertyValue: number;
  sensors?: SensorDataForAI;
}

type VoiceAssistantToggleAction = 'toggle' | 'connect' | 'disconnect';
type RealtimeResponseModality = 'audio' | 'text';
type AssistantMemoryPersistReason = 'interval' | 'disconnect' | 'clear' | 'unmount';

type VoiceAssistantToggleDetail = {
  action?: VoiceAssistantToggleAction;
};

type VoiceAssistantPromptDetail = {
  prompt?: string;
  modalities?: RealtimeResponseModality[];
  source?: string;
  requestId?: string;
};

type DashboardRealtimeSurface = {
  id: string;
  title: string;
  source?: string;
  keywords?: string[];
};

function compactAssistantActionResultForModel(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') {
    return { ok: Boolean(result), summary: result == null ? 'Action finished.' : String(result) };
  }

  const payload = result as Record<string, any>;
  const breakdown = payload.result && typeof payload.result === 'object' ? payload.result : null;
  const categoryTotals = Array.isArray(breakdown?.categoryTotals)
    ? breakdown.categoryTotals.slice(0, 12)
    : Array.isArray(breakdown?.lines)
      ? breakdown.lines.slice(0, 12).map((line: any) => ({
          category: line.category || line.label,
          amount: line.amount,
        }))
      : [];

  return {
    ok: payload.ok !== false,
    actionId: payload.actionId || null,
    title: payload.title || null,
    summary: payload.summary || breakdown?.speakableAnswer || breakdown?.summary || null,
    speakableAnswer: breakdown?.speakableAnswer || payload.summary || null,
    verdict: breakdown?.verdict || null,
    total: breakdown?.total ?? null,
    totalExpenses: breakdown?.totalExpenses ?? null,
    totalIncome: breakdown?.totalIncome ?? null,
    matchedCategory: breakdown?.matchedCategory || null,
    periodLabel: breakdown?.periodLabel || null,
    categoryTotals,
    incomeTotals: Array.isArray(breakdown?.incomeTotals) ? breakdown.incomeTotals.slice(0, 8) : [],
    metrics: Array.isArray(breakdown?.metrics) ? breakdown.metrics.slice(0, 12) : [],
    bullets: Array.isArray(breakdown?.bullets) ? breakdown.bullets.slice(0, 10) : [],
    scenarios: Array.isArray(breakdown?.scenarios) ? breakdown.scenarios.slice(0, 6) : [],
    sampleTransactions: Array.isArray(breakdown?.sampleTransactions)
      ? breakdown.sampleTransactions.slice(0, 8)
      : Array.isArray(breakdown?.lines)
        ? breakdown.lines.slice(0, 8)
        : [],
    entryCount: breakdown?.entryCount ?? null,
    needsInput: Boolean(payload.needsInput),
    error: payload.error || null,
    dataSource: breakdown?.dataSource || null,
    navigation: payload.navigation || null,
  };
}

function openAnalyticsResultInTaskPad(payload: {
  actionId: string;
  title: string;
  summary: string;
  result: Record<string, unknown>;
  actions?: Array<Record<string, unknown>>;
  navigationRoute?: string | null;
}) {
  emitAssistantActionProgress({
    actionId: payload.actionId,
    title: payload.title,
    summary: payload.summary,
    status: 'complete',
    currentStep: 4,
    steps: [
      'Review your request',
      'Open the right workspace',
      'Pull live account numbers',
      'Build the visual breakdown',
      'Ready for your review',
    ],
    detailMessage: 'Numbers are on the task pad so you can follow along.',
    result: payload.result as any,
    actions: (payload.actions || []) as any,
  });
}

function formatMetricMoney(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${Math.round(num).toLocaleString()}`;
}

function buildPortfolioMetricPadResult(metricResult: any) {
  const perProperty = Array.isArray(metricResult?.perProperty) ? metricResult.perProperty : [];
  const first = perProperty[0] || null;
  const totals = metricResult?.totals || {};
  const bullets = Array.isArray(metricResult?.derivation)
    ? metricResult.derivation.slice(0, 8)
    : [];
  const metrics = [
    { label: 'NOI', value: formatMetricMoney(totals.noi ?? metricResult?.value) },
    { label: 'Cash flow / yr', value: formatMetricMoney(totals.netCashFlow) },
    { label: 'Gross income', value: formatMetricMoney(totals.grossIncome) },
    { label: 'OpEx', value: formatMetricMoney(totals.operatingExpenses) },
    { label: 'Debt service', value: formatMetricMoney(totals.debtService) },
    { label: 'Equity', value: formatMetricMoney(totals.totalEquity) },
  ];
  if (first?.ledgerExpenseCategories?.length) {
    first.ledgerExpenseCategories.slice(0, 4).forEach((entry: any) => {
      metrics.push({
        label: entry.category,
        value: formatMetricMoney(entry.amount),
      });
    });
  }

  return {
    type: 'property_analysis',
    title: `${String(metricResult?.metric || 'portfolio').replace(/_/g, ' ')} analysis`,
    summary: metricResult?.scope
      ? `Scoped to ${metricResult.scope}.`
      : 'Portfolio metric breakdown',
    propertyAddress: metricResult?.propertyMatched || first?.address || undefined,
    verdict: metricResult?.value != null
      ? `Primary value: ${typeof metricResult.value === 'number' ? formatMetricMoney(metricResult.value) : String(metricResult.value)}`
      : undefined,
    bullets,
    metrics,
    nextSteps: [
      'Open the property Analytics tab for charts.',
      'Ask for a cash-out refinance check if you want scenario comparison.',
    ],
    speakableAnswer: bullets[0] || `Computed ${metricResult?.metric || 'metric'} for ${metricResult?.scope || 'portfolio'}.`,
  };
}

type DashboardRealtimeAction = {
  id: string;
  name: string;
  description?: string;
  destination?: string | null;
};

type DashboardRealtimeSurfaceSize = 'full' | 'wide' | 'half' | 'third';
type DashboardRealtimeSurfaceHeight = 'compact' | 'standard' | 'tall' | 'hero';
type DashboardRealtimeAnnotationPlacement =
  | 'top-left'
  | 'top'
  | 'top-right'
  | 'right'
  | 'bottom-right'
  | 'bottom'
  | 'bottom-left'
  | 'left'
  | 'center';
type DashboardRealtimeAnnotationTone = 'neutral' | 'info' | 'success' | 'warning';
type DashboardRealtimeAnnotationWidth = 'sm' | 'md' | 'lg';

type DashboardRealtimeSurfaceLayout = {
  id: string;
  order?: number;
  size?: DashboardRealtimeSurfaceSize;
  height?: DashboardRealtimeSurfaceHeight;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  zIndex?: number;
  emphasis?: boolean;
};

type DashboardRealtimeContextDetail = {
  enabled?: boolean;
  currentSurfaceIds?: string[];
  availableSurfaces?: DashboardRealtimeSurface[];
  currentSurfaceLayouts?: DashboardRealtimeSurfaceLayout[];
  availableActions?: DashboardRealtimeAction[];
  annotationsEnabled?: boolean;
  annotationPlacements?: DashboardRealtimeAnnotationPlacement[];
  annotationTones?: DashboardRealtimeAnnotationTone[];
  annotationWidths?: DashboardRealtimeAnnotationWidth[];
  propertyCount?: number;
  propertyAddresses?: string[];
  portfolioSnapshotCount?: number;
  transactionCount?: number;
  maintenanceDeviceCount?: number;
  totalPropertyValue?: number;
  reserveSummary?: Record<string, unknown>;
  propertyValueBreakdown?: Array<{ key: string; label: string; value: number; percent: number }>;
  propertyCashFlowSnapshots?: Array<{
    surfaceId: string;
    propertyId?: string;
    propertyLabel: string;
    yearlyValues: Array<{
      year: string;
      value: number;
      formatted: string;
    }>;
  }>;
  activeSegmentHighlights?: Array<{ surfaceId: string; keys: string[] }>;
  lastHighlightedSurfaceId?: string | null;
};

type OpenAIMessageTransport = {
  kind: 'audio' | 'text';
  send: (data: string) => void;
};

type OpenAIPromptMetadata = {
  source?: string;
  requestId?: string;
};

type ActiveOpenAIPromptMetadata = OpenAIPromptMetadata & {
  prompt: string;
};

type PendingSensitiveRealtimePrompt = {
  prompt: string;
  modalities: RealtimeResponseModality[];
  metadata?: OpenAIPromptMetadata;
};

type TouchIdUnlockOutcome = {
  ok: boolean;
  message: string;
};

type VoiceIdentityStatus = {
  hasEnrollment: boolean;
  sampleCount: number;
  recommendedSamples: number;
  threshold: number;
  engine?: string;
};

type VoiceIdentityBusyAction = 'enroll' | 'verify' | 'reset' | 'touchid' | null;

const DEFAULT_REALTIME_MODALITIES: RealtimeResponseModality[] = ['audio'];
const DEFAULT_DASHBOARD_SCENE_WIDTH = 1200;
const DEFAULT_DASHBOARD_SURFACE_SIZES: DashboardRealtimeSurfaceSize[] = ['full', 'wide', 'half', 'third'];
const DEFAULT_DASHBOARD_SURFACE_HEIGHTS: DashboardRealtimeSurfaceHeight[] = ['compact', 'standard', 'tall', 'hero'];
const DEFAULT_DASHBOARD_ANNOTATION_PLACEMENTS: DashboardRealtimeAnnotationPlacement[] = ['top-left', 'top', 'top-right', 'right', 'bottom-right', 'bottom', 'bottom-left', 'left', 'center'];
const DEFAULT_DASHBOARD_ANNOTATION_TONES: DashboardRealtimeAnnotationTone[] = ['neutral', 'info', 'success', 'warning'];
const DEFAULT_DASHBOARD_ANNOTATION_WIDTHS: DashboardRealtimeAnnotationWidth[] = ['sm', 'md', 'lg'];
const VOICE_IDENTITY_CAPTURE_DURATION_MS = 3500;
const VOICE_IDENTITY_PASSIVE_MIN_DURATION_MS = 1400;
const VOICE_IDENTITY_PASSIVE_MIN_TRANSCRIPT_LENGTH = 8;
const VOICE_IDENTITY_PASSIVE_VERIFY_COOLDOWN_MS = 45000;
const SENSITIVE_VOICE_INTENT_PATTERNS = [
  /transaction/i,
  /bookkeep/i,
  /ledger/i,
  /tax/i,
  /net\s*worth/i,
  /portfolio/i,
  /holding/i,
  /balance\s*sheet/i,
  /profit\s*(and|&)\s*loss/i,
  /cash\s*flow/i,
  /finance\s*document/i,
  /schedule\s*e/i,
  /1099/i,
  /workpaper/i,
  /reserve/i,
  /equity/i,
  /bank\s*account/i,
  /statement/i,
];

function normalizeRealtimeModalities(modalities?: RealtimeResponseModality[]) {
  if (!Array.isArray(modalities) || modalities.length === 0) {
    return DEFAULT_REALTIME_MODALITIES;
  }

  const normalized = Array.from(new Set(modalities.filter(
    (modality): modality is RealtimeResponseModality => modality === 'audio' || modality === 'text',
  )));

  return normalized.length > 0 ? normalized : DEFAULT_REALTIME_MODALITIES;
}

function isTextOnlyRealtimeModalities(modalities: RealtimeResponseModality[]) {
  return modalities.length === 1 && modalities[0] === 'text';
}

function isSensitiveFinancialVoiceIntent(value: string) {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    return false;
  }

  return SENSITIVE_VOICE_INTENT_PATTERNS.some((pattern) => pattern.test(normalizedValue));
}

function buildVoiceFinancialContext(currentUserData: UserDataForAI | null) {
  if (!currentUserData) {
    return '';
  }

  let contextInfo = `\nUSER'S PROPERTY DATA:\n- Total Property Value: $${currentUserData.totalPropertyValue?.toLocaleString() || 'Unknown'}\n- Number of properties: ${currentUserData.properties?.length || 0}`;
  if (currentUserData.properties?.length > 0) {
    contextInfo += `\n- Properties: ${currentUserData.properties.map((property) => `${property.address} ($${property.value.toLocaleString()})`).join(', ')}`;
  }
  return contextInfo;
}

function buildVoiceFinancialLockMessage(hasEnrollment: boolean) {
  return hasEnrollment
    ? 'Private financial details stay locked until the app verifies your live voice or you confirm Touch ID for this session.'
    : 'Private financial details stay locked until you confirm Touch ID for this session or add voice samples for future automatic voice checks.';
}

function isLikelyFinancialVoiceLockResponse(value: string) {
  const normalizedValue = value.trim().toLowerCase();
  if (!normalizedValue) {
    return false;
  }

  return (
    normalizedValue.includes('financial voice mode is locked')
    || normalizedValue.includes('verify your voice')
    || normalizedValue.includes('voice is locked')
    || normalizedValue.includes('checking the enrolled speaker')
    || normalizedValue.includes('future voice conversations will verify automatically')
    || normalizedValue.includes('confirm touch id')
    || normalizedValue.includes('private financial details stay locked')
  );
}

function formatVoiceUnlockExpiry(expiresAt?: string | null) {
  if (!expiresAt) {
    return null;
  }

  const value = new Date(expiresAt);
  if (Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Top OpenAI Realtime voices (marin & cedar recommended for best quality)
export const VoiceAISupportLiveKit: React.FC = () => {
  const navigate = useNavigate();
  const voiceCommands = useVoiceCommand();
  const screenContext = useScreenContext();
  const screenContextRef = useRef(screenContext);
  const { user } = useAuth();

  // Real-time sensor data from Firestore
  const { devices: shellyDevices, alerts: shellyAlerts, loading: shellyLoading } = useShellyFirestore();

  // User data for AI context
  const [userData, setUserData] = useState<UserDataForAI | null>(null);
  const userDataRef = useRef<UserDataForAI | null>(null);
  const assistantCanonicalContextRef = useRef('');
  const [voiceFinancialUnlock, setVoiceFinancialUnlock] = useState<VoiceFinancialUnlock | null>(null);
  // Financial gating is disabled for the assistant in this build.
  const voiceFinancialAccessUnlocked = true;

  const openaiVoice = 'marin';

  // Fetch user data on mount and when user changes
  useEffect(() => {
    const fetchUserData = async () => {
      if (!user?.id) {
        setUserData(null);
        userDataRef.current = null;
        return;
      }

      try {
        let properties: UserDataForAI['properties'] = [];
        let totalPropertyValue = 0;

        if (voiceFinancialAccessUnlocked) {
          console.log('[VoiceAI] 📊 Fetching unlocked property data for:', user.id);
          const assets = await getAssets(user.id);

          properties = (assets.realEstate || []).map((p: any) => ({
            address: p.name || 'Property',
            value: p.value || 0,
          }));

          totalPropertyValue = (assets.realEstate || []).reduce((sum: number, a: any) => sum + (a.value || 0), 0);
        }

        const unacknowledgedAlerts = shellyAlerts.filter((a: any) => !a.acknowledged);
        const sensorData: SensorDataForAI = {
          totalSensors: shellyDevices.length,
          onlineSensors: shellyDevices.filter((d: any) => d.status === 'online').length,
          devices: shellyDevices.map((d: any) => ({
            id: d.id,
            name: d.name || d.deviceId || 'Unnamed Sensor',
            location: d.location,
            status: d.status,
            isFlooded: d.isFlooded || d.flood || false,
            batteryLevel: d.batteryLevel || d.batteryPercent,
            temperature: d.temperature
          })),
          recentAlerts: shellyAlerts.slice(0, 10).map((a: any) => ({
            id: a.id,
            type: a.type,
            severity: a.severity,
            message: a.message,
            timestamp: a.timestamp instanceof Date ? a.timestamp.toISOString() : String(a.timestamp),
            deviceName: a.deviceName || a.deviceId,
            acknowledged: a.acknowledged
          })),
          activeAlertCount: unacknowledgedAlerts.length,
          criticalAlertCount: unacknowledgedAlerts.filter((a: any) => a.severity === 'critical').length
        };

        const data: UserDataForAI = {
          properties,
          totalPropertyValue,
          sensors: sensorData,
        };

        console.log('[VoiceAI] 📊 User data loaded:', {
          properties: properties.length,
          totalPropertyValue,
          sensors: sensorData.totalSensors,
          activeAlerts: sensorData.activeAlertCount
        });

        setUserData(data);
        userDataRef.current = data;
      } catch (err) {
        console.error('[VoiceAI] Error fetching user data:', err);
      }
    };

    fetchUserData();
    const interval = setInterval(fetchUserData, 30000);
    return () => clearInterval(interval);
  }, [shellyAlerts, shellyDevices, user?.id, voiceFinancialAccessUnlocked]);

  // Keep ref in sync with latest screenContext
  useEffect(() => {
    screenContextRef.current = screenContext;
    console.log('[VoiceAI] 📍 Screen context updated:', screenContext.currentPage, screenContext.pageTitle);
  }, [screenContext]);

  // ===================================================================
  // SHARED UI STATE
  // ===================================================================
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [transcript, setTranscript] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const voiceOrbAmplitudeRef = useRef(0);
  const openaiRemoteStreamRef = useRef<MediaStream | null>(null);
  const lastOpenAISessionUpdateKeyRef = useRef('');
  const lastOpenAISessionUpdateAtRef = useRef(0);
  const openAISessionUpdateTimerRef = useRef<number | null>(null);
  const openAISpeakingStopTimerRef = useRef<number | null>(null);
  const [voiceIdentityStatus, setVoiceIdentityStatus] = useState<VoiceIdentityStatus | null>(null);
  const [voiceIdentityBusyAction, setVoiceIdentityBusyAction] = useState<VoiceIdentityBusyAction>(null);
  const [voiceIdentityMessage, setVoiceIdentityMessage] = useState('');
  const [isConnectingRealtime, setIsConnectingRealtime] = useState(false);
  const [showScheduledTasksModal, setShowScheduledTasksModal] = useState(false);
  const [showActivityCenter, setShowActivityCenter] = useState(false);
  const [assistantExperience, setAssistantExperienceState] = useState(() => getAssistantExperience());
  const [upcomingTaskCount, setUpcomingTaskCount] = useState(0);

  const messagesRef = useRef<Message[]>([]);
  const assistantMemoryRef = useRef<AssistantMemorySnapshot | null>(null);
  const assistantMemoryLoadedRef = useRef(false);
  const assistantMemoryLoadPromiseRef = useRef<Promise<AssistantMemorySnapshot | null> | null>(null);
  const assistantCanonicalContextLoadedRef = useRef(false);
  const assistantCanonicalContextLoadPromiseRef = useRef<Promise<string> | null>(null);
  const assistantCanonicalContextScopeKeyRef = useRef<string | null>(null);
  const assistantMemorySessionIdRef = useRef<string | null>(null);
  const assistantMemorySessionStartedAtRef = useRef<string | null>(null);
  const assistantMemorySessionStartIndexRef = useRef(0);
  const lastPersistedMemoryMessageCountRef = useRef(0);
  const isPersistingAssistantMemoryRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const orbAudioContextRef = useRef<AudioContext | null>(null);
  const orbAnalyserRef = useRef<AnalyserNode | null>(null);
  const orbSourceNodeRef = useRef<MediaElementAudioSourceNode | MediaStreamAudioSourceNode | null>(null);
  const orbSourceKeyRef = useRef<MediaStream | HTMLAudioElement | null>(null);
  const isSpeakingRef = useRef(false);

  // OpenAI Realtime WebRTC refs
  const openaiPcRef = useRef<RTCPeerConnection | null>(null);
  const openaiDcRef = useRef<RTCDataChannel | null>(null);
  const openaiAudioRef = useRef<HTMLAudioElement | null>(null);
  const openaiAudioStartedRef = useRef(false);
  const openaiAudioTranscriptBufferRef = useRef('');
  const openaiStreamRef = useRef<MediaStream | null>(null);
  const voiceIdentityLiveCaptureRef = useRef<PersistentMonoWavCaptureSession | null>(null);
  const pendingPassiveVoiceSampleRef = useRef<MonoWavCaptureResult | null>(null);
  const pendingPassiveVoiceTranscriptRef = useRef('');
  const pendingSensitivePassiveReplayRef = useRef<string | null>(null);
  const passiveVoiceVerificationInFlightRef = useRef(false);
  const passiveVoiceMismatchCountRef = useRef(0);
  const lastPassiveVoiceVerifyAtRef = useRef(0);
  const openaiTextWsRef = useRef<WebSocket | null>(null);
  const openaiTextResponseRef = useRef('');
  const openaiPendingPromptRef = useRef<Array<{ prompt: string; modalities: RealtimeResponseModality[]; metadata?: OpenAIPromptMetadata }>>([]);
  const pendingSensitiveRealtimeUnlockPromptRef = useRef<PendingSensitiveRealtimePrompt | null>(null);
  const openaiConnectPromiseRef = useRef<Promise<void> | null>(null);
  const lastOpenAIResponseModalitiesRef = useRef<RealtimeResponseModality[]>(DEFAULT_REALTIME_MODALITIES);
  const dashboardContextRef = useRef<DashboardRealtimeContextDetail | null>(null);
  const activeOpenAIPromptMetaRef = useRef<ActiveOpenAIPromptMetadata | null>(null);
  const lastOpenAIFunctionResultRef = useRef('');
  const openAIResponseInFlightRef = useRef(false);
  const openAIPendingResponseCreateRef = useRef(false);
  const openAIActiveTransportRef = useRef<OpenAIMessageTransport | null>(null);
  const processedOpenAIFunctionCallIdsRef = useRef<Set<string>>(new Set());
  const finalizedOpenAIResponseIdsRef = useRef<Set<string>>(new Set());
  const activeOpenAIResponseIdRef = useRef<string | null>(null);
  const [isOpenAIConnected, setIsOpenAIConnected] = useState(false);
  const [openaiTranscript, setOpenaiTranscript] = useState('');

  const isConnected = isOpenAIConnected;

  const baseUrl = getDevApiBaseUrl();
  const hasVoiceEnrollment = Boolean(voiceIdentityStatus?.hasEnrollment);
  const sensitiveVoiceLockMessage = 'Private financial details are available in this build.';
  const touchIdFinancialAccessUnlocked = false;
  const voiceFinancialUnlockLabel = formatVoiceUnlockExpiry(voiceFinancialUnlock?.expiresAt);
  const voiceFinancialStatusLabel = 'Available';
  const voiceFinancialStatusDescription = 'Financial details are always available to the assistant.';
  const voiceFinancialStatusClass = 'bg-emerald-400/20 text-emerald-100';

  useEffect(() => {
    let rafId = 0;
    let cancelled = false;

    const resetLevel = () => {
      voiceOrbAmplitudeRef.current = 0;
    };

    const getActiveAudioElement = () => currentAudioRef.current || openaiAudioRef.current;

    const startFallbackLoop = () => {
      const loop = () => {
        if (cancelled) return;
        if (isSpeaking) {
          const synthetic = 0.24 + 0.2 * (0.5 + 0.5 * Math.sin(performance.now() * 0.018));
          voiceOrbAmplitudeRef.current = synthetic;
          rafId = window.requestAnimationFrame(loop);
          return;
        }
        resetLevel();
      };
      rafId = window.requestAnimationFrame(loop);
    };

    const setup = async () => {
      if (!isSpeaking) {
        resetLevel();
        return;
      }

      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) {
        startFallbackLoop();
        return;
      }

      try {
        const audioContext = orbAudioContextRef.current || new AudioContextCtor();
        orbAudioContextRef.current = audioContext;
        if (audioContext.state === 'suspended') {
          await audioContext.resume().catch(() => {});
        }

        const analyser = orbAnalyserRef.current || audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.82;
        orbAnalyserRef.current = analyser;

        // Prefer the remote MediaStream for analysis so we never hijack the
        // <audio> element with createMediaElementSource (that can mute speakers).
        const remoteStream = openaiRemoteStreamRef.current;
        const sourceElement = getActiveAudioElement();
        const sourceKey = remoteStream || sourceElement;
        if (!sourceKey) {
          startFallbackLoop();
          return;
        }

        if (orbSourceKeyRef.current !== sourceKey) {
          orbSourceNodeRef.current?.disconnect();
          if (remoteStream) {
            orbSourceNodeRef.current = audioContext.createMediaStreamSource(remoteStream);
          } else if (sourceElement) {
            const captureCapableElement = sourceElement as HTMLAudioElement & {
              captureStream?: () => MediaStream;
            };
            const capturedStream = typeof captureCapableElement.captureStream === 'function'
              ? captureCapableElement.captureStream()
              : null;
            if (capturedStream) {
              orbSourceNodeRef.current = audioContext.createMediaStreamSource(capturedStream);
            } else {
              // Last resort: do not use createMediaElementSource — it redirects
              // element output through Web Audio and can silence playback.
              startFallbackLoop();
              return;
            }
          }
          orbSourceNodeRef.current?.connect(analyser);
          orbSourceKeyRef.current = sourceKey;
        }

        const samples = new Uint8Array(analyser.fftSize);
        const loop = () => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (let index = 0; index < samples.length; index += 1) {
            const normalized = (samples[index] - 128) / 128;
            sum += normalized * normalized;
          }
          const rms = Math.sqrt(sum / samples.length);
          // Write to a ref only — never setState here (that used to flood session.update).
          voiceOrbAmplitudeRef.current = Math.min(1, rms * 4.8);
          rafId = window.requestAnimationFrame(loop);
        };
        rafId = window.requestAnimationFrame(loop);
      } catch {
        startFallbackLoop();
      }
    };

    void setup();
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(rafId);
    };
  }, [isSpeaking]);

  const refreshVoiceIdentityStatus = useCallback(async () => {
    try {
      const response = await getVoiceIdentityStatus();
      if (response.ok) {
        setVoiceIdentityStatus({
          hasEnrollment: Boolean(response.hasEnrollment),
          sampleCount: Number(response.sampleCount) || 0,
          recommendedSamples: Number(response.recommendedSamples) || 3,
          threshold: Number(response.threshold) || 0.74,
          engine: response.engine,
        });
        return;
      }

      if (response.message) {
        setVoiceIdentityMessage(response.message);
      }
    } catch (error: any) {
      if (user?.id) {
        setVoiceIdentityMessage(error?.message || 'Voice identity status is unavailable.');
      }
    }
  }, [user?.id]);

  const lockFinancialVoiceMode = useCallback((nextMessage?: string) => {
    clearStoredVoiceFinancialUnlock(user?.id);
    setVoiceFinancialUnlock(null);
    pendingPassiveVoiceSampleRef.current = null;
    pendingPassiveVoiceTranscriptRef.current = '';
    pendingSensitivePassiveReplayRef.current = null;
    pendingSensitiveRealtimeUnlockPromptRef.current = null;
    passiveVoiceMismatchCountRef.current = 0;
    lastPassiveVoiceVerifyAtRef.current = 0;
    if (nextMessage) {
      setVoiceIdentityMessage(nextMessage);
    }
  }, [user?.id]);

  const handleBiometricFinancialUnlock = useCallback(async (): Promise<TouchIdUnlockOutcome> => {
    if (voiceIdentityBusyAction) {
      return {
        ok: false,
        message: voiceIdentityBusyAction === 'touchid'
          ? 'Touch ID confirmation is already in progress.'
          : 'Finish the current voice security step first.',
      };
    }

    if (!user?.id) {
      const message = 'Financial access requires a signed-in Firebase session.';
      setVoiceIdentityMessage(message);
      return { ok: false, message };
    }

    try {
      setVoiceIdentityBusyAction('touchid');
      setVoiceIdentityMessage('Confirm Touch ID to unlock private financial details for this session...');
      const response = await verifyBiometricFinancialUnlock(user.id);
      writeStoredVoiceFinancialUnlock(user.id, response.unlock, { scope: 'session' });
      setVoiceFinancialUnlock(response.unlock);
      const message = response.createdCredential
        ? 'Touch ID is set up on this device. Private financial details are unlocked for this session.'
        : 'Touch ID verified. Private financial details are unlocked for this session.';
      setVoiceIdentityMessage(message);
      return { ok: true, message };
    } catch (error: any) {
      const message = error?.message || 'Touch ID verification failed.';
      setVoiceIdentityMessage(message);
      return { ok: false, message };
    } finally {
      setVoiceIdentityBusyAction(null);
    }
  }, [user?.id, voiceIdentityBusyAction]);

  const applyVoiceFinancialUnlock = useCallback((response: any, options?: {
    quiet?: boolean;
    message?: string;
  }) => {
    if (!user?.id || !response?.unlockExpiresAt) {
      return;
    }

    const unlock: VoiceFinancialUnlock = {
      expiresAt: response.unlockExpiresAt,
      verifiedAt: new Date().toISOString(),
      score: Number(response.score) || 0,
      threshold: Number(response.threshold) || 0,
      engine: response.engine,
    };

    writeStoredVoiceFinancialUnlock(user.id, unlock);
    setVoiceFinancialUnlock(unlock);
    passiveVoiceMismatchCountRef.current = 0;
    lastPassiveVoiceVerifyAtRef.current = Date.now();

    if (!options?.quiet) {
      setVoiceIdentityMessage(options?.message || `Verified speaker matched automatically until ${formatVoiceUnlockExpiry(response.unlockExpiresAt) || 'soon'}.`);
    }
  }, [user?.id]);

  const runPassiveVoiceVerification = useCallback(async (
    sample: MonoWavCaptureResult | null,
    transcriptText: string,
  ) => {
    if (
      !user?.id
      || !voiceIdentityStatus?.hasEnrollment
      || touchIdFinancialAccessUnlocked
      || !sample?.audioBase64
      || sample.durationMs < VOICE_IDENTITY_PASSIVE_MIN_DURATION_MS
    ) {
      return;
    }

    if (voiceIdentityBusyAction || passiveVoiceVerificationInFlightRef.current) {
      return;
    }

    const now = Date.now();
    if (
      voiceFinancialAccessUnlocked
      && now - lastPassiveVoiceVerifyAtRef.current < VOICE_IDENTITY_PASSIVE_VERIFY_COOLDOWN_MS
    ) {
      return;
    }

    passiveVoiceVerificationInFlightRef.current = true;

    try {
      const response = await verifyVoiceIdentitySample(sample.audioBase64, { verificationMode: 'passive' });

      if (!response.ok) {
        if (response.error === 'voice_sample_too_short') {
          return;
        }
        throw new Error(response.message || 'Passive voice verification failed.');
      }

      if (response.matched && response.unlockExpiresAt) {
        applyVoiceFinancialUnlock(response, {
          quiet: voiceFinancialAccessUnlocked,
          message: voiceFinancialAccessUnlocked
            ? undefined
            : `Verified speaker detected automatically. Private financial details are available until ${formatVoiceUnlockExpiry(response.unlockExpiresAt) || 'soon'}.`,
        });
        return;
      }

      passiveVoiceMismatchCountRef.current += 1;

      if (!touchIdFinancialAccessUnlocked && voiceFinancialAccessUnlocked && passiveVoiceMismatchCountRef.current >= 2) {
        lockFinancialVoiceMode('The live voice no longer matches the enrolled speaker. Private financial details will stay hidden until the match returns.');
      }
    } catch (error) {
      console.error('[Voice Identity] Passive verification error:', error);
    } finally {
      passiveVoiceVerificationInFlightRef.current = false;
    }
  }, [
    applyVoiceFinancialUnlock,
    lockFinancialVoiceMode,
    touchIdFinancialAccessUnlocked,
    user?.id,
    voiceFinancialAccessUnlocked,
    voiceIdentityBusyAction,
    voiceIdentityStatus?.hasEnrollment,
  ]);

  const flushPendingPassiveVoiceVerification = useCallback(() => {
    const pendingSample = pendingPassiveVoiceSampleRef.current;
    const pendingTranscript = pendingPassiveVoiceTranscriptRef.current.trim();
    if (!pendingSample) {
      return;
    }

    pendingPassiveVoiceSampleRef.current = null;
    pendingPassiveVoiceTranscriptRef.current = '';
    void runPassiveVoiceVerification(pendingSample, pendingTranscript);
  }, [runPassiveVoiceVerification]);

  const replayPendingSensitiveOpenAIResponse = useCallback(() => {
    const pendingPrompt = pendingSensitivePassiveReplayRef.current?.trim();
    const channel = openaiDcRef.current;

    if (!pendingPrompt || !voiceFinancialAccessUnlocked || !channel || channel.readyState !== 'open') {
      return false;
    }

    pendingSensitivePassiveReplayRef.current = null;
    const transport: OpenAIMessageTransport = {
      kind: 'audio',
      send: (data) => channel.send(data),
    };

    setVoiceIdentityMessage('Verified speaker detected automatically. Answering your private financial question now.');
    setIsProcessing(true);
    try {
      transport.send(JSON.stringify({ type: 'response.cancel' }));
    } catch {
      // Ignore if there is no active response to cancel.
    }
    sendOpenAISessionUpdate(transport);
    transport.send(JSON.stringify({ type: 'response.create' }));
    return true;
  }, [voiceFinancialAccessUnlocked]);

  useEffect(() => {
    replayPendingSensitiveOpenAIResponse();
  }, [replayPendingSensitiveOpenAIResponse, voiceFinancialAccessUnlocked]);

  const getAuthenticatedRealtimeHeaders = useCallback(async () => {
    const headers = await getOwnerFinanceHeaders({ 'Content-Type': 'application/json' });
    if (!headers) {
      throw new Error('Voice assistant requires a signed-in Firebase session.');
    }
    return headers;
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setVoiceFinancialUnlock(null);
      setVoiceIdentityStatus(null);
      setVoiceIdentityMessage('');
      return;
    }

    const storedUnlock = readStoredVoiceFinancialUnlock(user.id);
    if (storedUnlock && isVoiceFinancialUnlockActive(storedUnlock)) {
      setVoiceFinancialUnlock(storedUnlock);
    } else {
      clearStoredVoiceFinancialUnlock(user.id);
      setVoiceFinancialUnlock(null);
    }

    void refreshVoiceIdentityStatus();
  }, [refreshVoiceIdentityStatus, user?.id]);

  useEffect(() => {
    if (!voiceFinancialUnlock?.expiresAt || !user?.id) {
      return;
    }

    const remainingMs = new Date(voiceFinancialUnlock.expiresAt).getTime() - Date.now();
    if (remainingMs <= 0) {
      lockFinancialVoiceMode('The live speaker check expired. Private financial details will stay hidden until the enrolled voice matches again.');
      return;
    }

    const timeoutId = window.setTimeout(() => {
      lockFinancialVoiceMode('The live speaker check expired. Private financial details will stay hidden until the enrolled voice matches again.');
    }, remainingMs + 50);

    return () => window.clearTimeout(timeoutId);
  }, [lockFinancialVoiceMode, user?.id, voiceFinancialUnlock?.expiresAt]);

  useEffect(() => {
    if (!user?.id || !voiceFinancialUnlock?.sessionScoped) {
      return;
    }

    const clearSessionUnlockOnRefresh = () => {
      clearStoredVoiceFinancialUnlock(user.id, { scope: 'session' });
    };

    window.addEventListener('beforeunload', clearSessionUnlockOnRefresh);
    return () => window.removeEventListener('beforeunload', clearSessionUnlockOnRefresh);
  }, [user?.id, voiceFinancialUnlock?.sessionScoped]);

  const resetAssistantMemoryTracking = useCallback(() => {
    assistantMemorySessionIdRef.current = null;
    assistantMemorySessionStartedAtRef.current = null;
    assistantMemorySessionStartIndexRef.current = messagesRef.current.length;
    lastPersistedMemoryMessageCountRef.current = 0;
  }, []);

  useEffect(() => {
    const nextScopeKey = user?.id
      ? `${user.id}:${voiceFinancialAccessUnlocked ? 'financial' : 'redacted'}`
      : null;

    if (assistantCanonicalContextScopeKeyRef.current === nextScopeKey) {
      return;
    }

    assistantCanonicalContextRef.current = '';
    assistantCanonicalContextLoadedRef.current = false;
    assistantCanonicalContextLoadPromiseRef.current = null;
    assistantCanonicalContextScopeKeyRef.current = nextScopeKey;
  }, [user?.id, voiceFinancialAccessUnlocked]);

  const loadAssistantMemorySnapshot = useCallback(async (force = false) => {
    if (!user?.id) {
      assistantMemoryRef.current = null;
      assistantMemoryLoadedRef.current = true;
      assistantMemoryLoadPromiseRef.current = null;
      return null;
    }

    if (!force && assistantMemoryLoadedRef.current) {
      return assistantMemoryRef.current;
    }

    if (!force && assistantMemoryLoadPromiseRef.current) {
      return assistantMemoryLoadPromiseRef.current;
    }

    const loadPromise = getAssistantMemory(user.id)
      .then((snapshot) => {
        assistantMemoryRef.current = snapshot;
        assistantMemoryLoadedRef.current = true;
        assistantMemoryLoadPromiseRef.current = null;
        return snapshot;
      })
      .catch((error) => {
        console.error('[VoiceAI] Failed to load assistant memory:', error);
        assistantMemoryLoadPromiseRef.current = null;
        assistantMemoryLoadedRef.current = false;
        return assistantMemoryRef.current;
      });

    assistantMemoryLoadPromiseRef.current = loadPromise;
    return loadPromise;
  }, [user?.id]);

  const loadAssistantCanonicalContext = useCallback(async (force = false) => {
    if (!user?.id) {
      assistantCanonicalContextRef.current = '';
      assistantCanonicalContextLoadedRef.current = false;
      assistantCanonicalContextLoadPromiseRef.current = null;
      assistantCanonicalContextScopeKeyRef.current = null;
      return '';
    }

    const scopeKey = `${user.id}:${voiceFinancialAccessUnlocked ? 'financial' : 'redacted'}`;

    if (!force && assistantCanonicalContextLoadedRef.current && assistantCanonicalContextScopeKeyRef.current === scopeKey) {
      return assistantCanonicalContextRef.current;
    }

    if (!force && assistantCanonicalContextLoadPromiseRef.current && assistantCanonicalContextScopeKeyRef.current === scopeKey) {
      return assistantCanonicalContextLoadPromiseRef.current;
    }

    assistantCanonicalContextRef.current = '';
    assistantCanonicalContextLoadedRef.current = false;
    assistantCanonicalContextScopeKeyRef.current = scopeKey;

    let loadPromise: Promise<string>;

    loadPromise = fetchAssistantCanonicalContext({
        includeFinancialDetails: voiceFinancialAccessUnlocked,
        includeGlobalContext: true,
      })
      .then((response) => {
        const nextContext = typeof response.promptContext === 'string'
          ? response.promptContext.trim()
          : '';

        if (assistantCanonicalContextScopeKeyRef.current === scopeKey) {
          assistantCanonicalContextRef.current = nextContext;
          assistantCanonicalContextLoadedRef.current = true;
        }

        return nextContext;
      })
      .catch((error) => {
        console.error('[VoiceAI] Failed to load canonical assistant context:', error);

        if (assistantCanonicalContextScopeKeyRef.current === scopeKey) {
          assistantCanonicalContextRef.current = '';
          assistantCanonicalContextLoadedRef.current = false;
        }

        return '';
      })
      .finally(() => {
        if (assistantCanonicalContextLoadPromiseRef.current === loadPromise) {
          assistantCanonicalContextLoadPromiseRef.current = null;
        }
      });

    assistantCanonicalContextLoadPromiseRef.current = loadPromise;
    return loadPromise;
  }, [user?.id, voiceFinancialAccessUnlocked]);

  const ensureAssistantMemorySession = useCallback((timestamp: Date = new Date()) => {
    if (!assistantMemorySessionIdRef.current) {
      assistantMemorySessionIdRef.current = `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      assistantMemorySessionStartedAtRef.current = timestamp.toISOString();
      assistantMemorySessionStartIndexRef.current = messagesRef.current.length;
      lastPersistedMemoryMessageCountRef.current = 0;
      return;
    }

    if (!assistantMemorySessionStartedAtRef.current) {
      assistantMemorySessionStartedAtRef.current = timestamp.toISOString();
    }
  }, []);

  useEffect(() => {
    if (!user?.id) {
      assistantCanonicalContextRef.current = '';
      return;
    }

    void loadAssistantCanonicalContext();
  }, [loadAssistantCanonicalContext, user?.id]);

  const appendConversationMessage = useCallback((message: Message) => {
    const content = message.content.trim();
    if (!content) {
      return;
    }

    const nextMessage = {
      ...message,
      content,
    };

    if (nextMessage.role === 'user') {
      ensureAssistantMemorySession(nextMessage.timestamp);
    }

    setMessages((prev) => {
      const nextMessages = [...prev, nextMessage];
      messagesRef.current = nextMessages;
      return nextMessages;
    });
  }, [ensureAssistantMemorySession]);

  const persistAssistantMemory = useCallback(async (reason: AssistantMemoryPersistReason) => {
    if (!user?.id || isPersistingAssistantMemoryRef.current) {
      return;
    }

    const currentMessages = messagesRef.current
      .slice(assistantMemorySessionStartIndexRef.current)
      .filter((message) => Boolean(message.content.trim()));
    if (currentMessages.length === 0) {
      return;
    }

    const hasUnflushedMessages = currentMessages.length > lastPersistedMemoryMessageCountRef.current;
    const unflushedMessages = currentMessages.slice(lastPersistedMemoryMessageCountRef.current);
    if (reason === 'interval') {
      const hasImmediateSignal = hasImmediateAssistantMemorySignal(unflushedMessages);
      if (
        currentMessages.length - lastPersistedMemoryMessageCountRef.current < ASSISTANT_MEMORY_FLUSH_MESSAGE_INTERVAL
        && !hasImmediateSignal
      ) {
        return;
      }
    } else if (!hasUnflushedMessages) {
      return;
    }

    const firstMessageTimestamp = currentMessages.find((message) => message.role === 'user')?.timestamp || currentMessages[0]?.timestamp || new Date();
    const firstMessageDate = firstMessageTimestamp instanceof Date
      ? firstMessageTimestamp
      : new Date(firstMessageTimestamp);
    const sessionId = assistantMemorySessionIdRef.current || `assistant-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionStartedAt = assistantMemorySessionStartedAtRef.current || firstMessageDate.toISOString();

    assistantMemorySessionIdRef.current = sessionId;
    assistantMemorySessionStartedAtRef.current = sessionStartedAt;
    isPersistingAssistantMemoryRef.current = true;

    try {
      const existingMemory = await loadAssistantMemorySnapshot(true);
      const nextMemory = buildAssistantMemorySnapshot({
        existing: existingMemory,
        messages: currentMessages,
        sessionId,
        sessionStartedAt,
        userData: userDataRef.current,
      });
      const result = await setAssistantMemory(user.id, nextMemory);

      if (!result.success) {
        throw new Error(result.error || 'Failed to save assistant memory');
      }

      assistantMemoryRef.current = nextMemory;
      assistantMemoryLoadedRef.current = true;
      if (reason === 'interval') {
        lastPersistedMemoryMessageCountRef.current = currentMessages.length;
      }
    } catch (error) {
      console.error('[VoiceAI] Failed to persist assistant memory:', error);
    } finally {
      isPersistingAssistantMemoryRef.current = false;
    }
  }, [loadAssistantMemorySnapshot, user?.id]);

  // ===================================================================
  // NAVIGATION / HIGHLIGHT HELPERS
  // ===================================================================
  const navigateToPage = useCallback((page: string) => {
    const route = resolveAssistantPageRoute(page) || (page.startsWith('/') ? page : `/${page}`);
    console.log('[VoiceAI] ✅ NAVIGATING TO:', route);
    navigate(route);
    return `Navigated to ${page}`;
  }, [navigate]);

  const highlightUIElement = useCallback((elementId: string) => {
    console.log('[VoiceAI] 🎯 Highlighting:', elementId);
    voiceCommands.highlightElement(elementId, undefined, 5000);
    return `Highlighted ${elementId}`;
  }, [voiceCommands]);

  const clickUIElement = useCallback((elementId: string) => {
    console.log('[VoiceAI] 🖱️ Clicking:', elementId);
    const ok = voiceCommands.clickElement(elementId);
    return ok ? `Clicked ${elementId}` : `Could not find ${elementId} yet — try navigate/open first, then click again.`;
  }, [voiceCommands]);

  useEffect(() => {
    assistantMemoryRef.current = null;
    assistantMemoryLoadedRef.current = false;
    assistantMemoryLoadPromiseRef.current = null;
    resetAssistantMemoryTracking();

    if (!user?.id) {
      return;
    }

    void loadAssistantMemorySnapshot(true);
  }, [loadAssistantMemorySnapshot, resetAssistantMemoryTracking, user?.id]);

  useEffect(() => {
    const currentSessionMessages = messagesRef.current
      .slice(assistantMemorySessionStartIndexRef.current)
      .filter((message) => Boolean(message.content.trim()));
    const currentSessionMessageCount = currentSessionMessages.length;
    const unflushedMessages = currentSessionMessages.slice(lastPersistedMemoryMessageCountRef.current);

    if (
      currentSessionMessageCount < ASSISTANT_MEMORY_FLUSH_MESSAGE_INTERVAL
      && !hasImmediateAssistantMemorySignal(unflushedMessages)
    ) {
      return;
    }

    void persistAssistantMemory('interval');
  }, [messages.length, persistAssistantMemory]);

  // ===================================================================
  // OPENAI REALTIME WebRTC
  // ===================================================================
  const connectOpenAIRealtime = async () => {
    if (openaiDcRef.current?.readyState === 'open') {
      setIsConnectingRealtime(false);
      setIsOpenAIConnected(true);
      setIsListening(true);
      return;
    }

    if (openaiConnectPromiseRef.current) {
      return openaiConnectPromiseRef.current;
    }

    const connectPromise = (async () => {
      try {
        setIsConnectingRealtime(true);
        setIsProcessing(true);

        const assistantMemoryPromise = loadAssistantMemorySnapshot();
        const assistantCanonicalContextPromise = loadAssistantCanonicalContext();
        const headersPromise = getAuthenticatedRealtimeHeaders();
        const streamPromise = navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 24000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        const [headers, stream] = await Promise.all([
          headersPromise,
          streamPromise,
        ]);

        const tokenPromise = (async () => {
          const tokenResponse = await fetch(`${baseUrl}/api/openai/realtime-webrtc-token`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ voice: openaiVoice }),
          });

          if (!tokenResponse.ok) {
            const err = await tokenResponse.json();
            throw new Error(err.error || 'Failed to get realtime token');
          }

          const { token } = await tokenResponse.json();
          return token as string;
        })();

        const pc = new RTCPeerConnection();
        openaiPcRef.current = pc;
        const audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.setAttribute('playsinline', 'true');
        (audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
        // Keep the element in the DOM — detached audio is flaky on some browsers.
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        openaiAudioRef.current = audioEl;

        const markOpenAIAudioStarted = () => {
          if (openAISpeakingStopTimerRef.current) {
            window.clearTimeout(openAISpeakingStopTimerRef.current);
            openAISpeakingStopTimerRef.current = null;
          }
          openaiAudioStartedRef.current = true;
          if (openaiAudioTranscriptBufferRef.current) {
            setOpenaiTranscript(openaiAudioTranscriptBufferRef.current);
          }
          setIsSpeaking(true);
        };

        const markOpenAIAudioStopped = () => {
          // Debounce brief WebRTC buffer pauses so we don't thrash speaking state.
          if (openAISpeakingStopTimerRef.current) {
            window.clearTimeout(openAISpeakingStopTimerRef.current);
          }
          openAISpeakingStopTimerRef.current = window.setTimeout(() => {
            openaiAudioStartedRef.current = false;
            setIsSpeaking(false);
            openAISpeakingStopTimerRef.current = null;
          }, 220);
        };

        audioEl.addEventListener('playing', markOpenAIAudioStarted);
        audioEl.addEventListener('ended', markOpenAIAudioStopped);
        // Ignore transient `pause` events during WebRTC buffering — they cause
        // choppy UI/orb churn and used to cascade into session.update storms.

        pc.ontrack = (e) => {
          const remoteStream = e.streams[0] || new MediaStream([e.track]);
          openaiRemoteStreamRef.current = remoteStream;
          audioEl.srcObject = remoteStream;
          void audioEl.play().catch(() => {
            // Voice mode is user-initiated; autoplay should usually succeed.
          });
        };

        openaiStreamRef.current = stream;
        // Skip continuous ScriptProcessor mic capture during realtime unless
        // voice enrollment is actively needed — it competes with WebRTC uplink.
        if (voiceIdentityLiveCaptureRef.current) {
          await voiceIdentityLiveCaptureRef.current.dispose().catch(() => {});
          voiceIdentityLiveCaptureRef.current = null;
        }
        pc.addTrack(stream.getTracks()[0]);

        const dc = pc.createDataChannel('oai-events');
        openaiDcRef.current = dc;
        const audioTransport: OpenAIMessageTransport = {
          kind: 'audio',
          send: (data) => dc.send(data),
        };

        void assistantMemoryPromise.then((assistantMemorySnapshot) => {
          if (assistantMemorySnapshot) {
            assistantMemoryRef.current = assistantMemorySnapshot;
          }

          if (dc.readyState === 'open') {
            scheduleOpenAISessionUpdate(audioTransport);
          }
        });

        void assistantCanonicalContextPromise.then(() => {
          if (dc.readyState === 'open') {
            scheduleOpenAISessionUpdate(audioTransport);
          }
        });

        const dataChannelOpenPromise = new Promise<void>((resolve, reject) => {
          dc.addEventListener('open', () => {
            setIsConnectingRealtime(false);
            setIsOpenAIConnected(true);
            setIsListening(true);
            setIsProcessing(false);
            scheduleOpenAISessionUpdate(audioTransport, { force: true, delayMs: 0 });
            flushPendingOpenAIPrompts();
            resolve();
          }, { once: true });

          dc.addEventListener('error', () => {
            reject(new Error('Failed to open OpenAI realtime data channel'));
          }, { once: true });
        });

        dc.addEventListener('message', (e) => {
          try { handleOpenAIEvent(JSON.parse(e.data), audioTransport); } catch (err) { /* ignore */ }
        });
        dc.addEventListener('close', () => {
          void persistAssistantMemory('disconnect');
          resetAssistantMemoryTracking();
          setIsOpenAIConnected(false);
          setIsListening(false);
        });

        const localDescriptionPromise = (async () => {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          return offer.sdp || pc.localDescription?.sdp || '';
        })();

        const [token, offerSdp] = await Promise.all([tokenPromise, localDescriptionPromise]);

        const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
          method: 'POST',
          body: offerSdp,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/sdp',
          },
        });
        if (!sdpResponse.ok) {
          const errorText = await sdpResponse.text();
          throw new Error(errorText || `SDP exchange failed: ${sdpResponse.status}`);
        }

        await pc.setRemoteDescription({ type: 'answer', sdp: await sdpResponse.text() });
        await dataChannelOpenPromise;

        console.log('[OpenAI Realtime] ✅ WebRTC connection established');
      } catch (err: any) {
        setIsConnectingRealtime(false);
        setIsProcessing(false);
        alert('Failed to connect to OpenAI Realtime: ' + err.message);
        disconnectOpenAIRealtime();
        throw err;
      } finally {
        openaiConnectPromiseRef.current = null;
      }
    })();

    openaiConnectPromiseRef.current = connectPromise;
    return connectPromise;
  };

  const disconnectOpenAIRealtime = () => {
    void persistAssistantMemory('disconnect');
    resetAssistantMemoryTracking();
    setIsConnectingRealtime(false);
    if (openAISessionUpdateTimerRef.current) {
      window.clearTimeout(openAISessionUpdateTimerRef.current);
      openAISessionUpdateTimerRef.current = null;
    }
    if (openAISpeakingStopTimerRef.current) {
      window.clearTimeout(openAISpeakingStopTimerRef.current);
      openAISpeakingStopTimerRef.current = null;
    }
    if (openaiDcRef.current) {
      openaiDcRef.current.close();
      openaiDcRef.current = null;
    }
    if (voiceIdentityLiveCaptureRef.current) {
      void voiceIdentityLiveCaptureRef.current.dispose().catch(() => {});
      voiceIdentityLiveCaptureRef.current = null;
    }
    if (openaiStreamRef.current) {
      openaiStreamRef.current.getTracks().forEach(track => track.stop());
      openaiStreamRef.current = null;
    }
    if (openaiPcRef.current) {
      openaiPcRef.current.close();
      openaiPcRef.current = null;
    }
    openaiRemoteStreamRef.current = null;
    orbSourceKeyRef.current = null;
    orbSourceNodeRef.current?.disconnect();
    orbSourceNodeRef.current = null;
    if (openaiAudioRef.current) {
      openaiAudioRef.current.pause();
      openaiAudioRef.current.srcObject = null;
      openaiAudioRef.current.remove();
      openaiAudioRef.current = null;
    }
    openaiAudioStartedRef.current = false;
    openaiAudioTranscriptBufferRef.current = '';
    lastOpenAISessionUpdateKeyRef.current = '';
    pendingPassiveVoiceSampleRef.current = null;
    pendingPassiveVoiceTranscriptRef.current = '';
    passiveVoiceMismatchCountRef.current = 0;
    voiceOrbAmplitudeRef.current = 0;
    setIsOpenAIConnected(false);
    setIsListening(false);
    setIsSpeaking(false);
    setOpenaiTranscript('');
  };

  const disconnectOpenAITextRealtime = () => {
    void persistAssistantMemory('disconnect');
    resetAssistantMemoryTracking();
    if (openaiTextWsRef.current) {
      openaiTextWsRef.current.close();
      openaiTextWsRef.current = null;
    }
    openaiTextResponseRef.current = '';
  };

  const dispatchDashboardRealtimeResponse = useCallback((
    text: string,
    metadata?: ActiveOpenAIPromptMetadata | null,
    error?: string,
  ) => {
    const activeMetadata = metadata ?? activeOpenAIPromptMetaRef.current;
    if (!activeMetadata || activeMetadata.source !== 'dashboard') {
      return;
    }

    window.dispatchEvent(new CustomEvent('houseyield:dashboard-response', {
      detail: {
        requestId: activeMetadata.requestId,
        prompt: activeMetadata.prompt,
        text,
        error,
      },
    }));
  }, []);

  async function requestTouchIdUnlockForSensitiveRealtimePrompt(
    prompt: string,
    modalities: RealtimeResponseModality[],
    metadata?: OpenAIPromptMetadata,
  ) {
    pendingSensitiveRealtimeUnlockPromptRef.current = { prompt, modalities, metadata };
    const outcome = await handleBiometricFinancialUnlock();

    if (outcome.ok) {
      return;
    }

    pendingSensitiveRealtimeUnlockPromptRef.current = null;
    appendConversationMessage({
      role: 'user',
      content: prompt,
      timestamp: new Date(),
    });
    appendConversationMessage({
      role: 'assistant',
      content: outcome.message || sensitiveVoiceLockMessage,
      timestamp: new Date(),
    });
    dispatchDashboardRealtimeResponse(outcome.message || sensitiveVoiceLockMessage, {
      prompt,
      ...(metadata || {}),
    });
  }

  const sendOpenAITextPromptToTransport = useCallback((
    transport: OpenAIMessageTransport,
    prompt: string,
    requestedModalities?: RealtimeResponseModality[],
    metadata?: OpenAIPromptMetadata,
  ) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return false;

    const modalities = normalizeRealtimeModalities(requestedModalities);

    if (
      transport.kind === 'text'
      && isSensitiveFinancialVoiceIntent(trimmedPrompt)
      && !voiceFinancialAccessUnlocked
    ) {
      void requestTouchIdUnlockForSensitiveRealtimePrompt(trimmedPrompt, modalities, metadata);
      return true;
    }

    lastOpenAIResponseModalitiesRef.current = modalities;
    activeOpenAIPromptMetaRef.current = {
      prompt: trimmedPrompt,
      ...(metadata || {}),
    };
    lastOpenAIFunctionResultRef.current = '';
    openaiTextResponseRef.current = '';
    setOpenaiTranscript('');
    setIsProcessing(true);
    setIsSpeaking(false);

    appendConversationMessage({
      role: 'user',
      content: trimmedPrompt,
      timestamp: new Date()
    });

    sendOpenAISessionUpdate(transport);

    transport.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: trimmedPrompt,
          },
        ],
      },
    }));
    transport.send(JSON.stringify({
      type: 'response.create',
    }));

    return true;
  }, [appendConversationMessage, dispatchDashboardRealtimeResponse, requestTouchIdUnlockForSensitiveRealtimePrompt, sensitiveVoiceLockMessage, voiceFinancialAccessUnlocked]);

  const sendOpenAITextPrompt = useCallback((
    prompt: string,
    requestedModalities?: RealtimeResponseModality[],
    metadata?: OpenAIPromptMetadata,
  ) => {
    const channel = openaiDcRef.current;
    if (!channel || channel.readyState !== 'open') return false;

    return sendOpenAITextPromptToTransport({
      kind: 'audio',
      send: (data) => channel.send(data),
    }, prompt, requestedModalities, metadata);
  }, [sendOpenAITextPromptToTransport]);

  const sendOpenAITextPromptOverWebSocket = useCallback((
    prompt: string,
    requestedModalities?: RealtimeResponseModality[],
    metadata?: OpenAIPromptMetadata,
  ) => {
    const ws = openaiTextWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    return sendOpenAITextPromptToTransport({
      kind: 'text',
      send: (data) => ws.send(data),
    }, prompt, requestedModalities, metadata);
  }, [sendOpenAITextPromptToTransport]);

  function flushPendingOpenAIPrompts() {
    const dcReady = Boolean(openaiDcRef.current && openaiDcRef.current.readyState === 'open');
    const wsReady = Boolean(openaiTextWsRef.current && openaiTextWsRef.current.readyState === WebSocket.OPEN);

    if (!dcReady && !wsReady) {
      return;
    }

    while (openaiPendingPromptRef.current.length > 0) {
      const nextPrompt = openaiPendingPromptRef.current.shift();
      if (!nextPrompt) {
        return;
      }

      const shouldUseTextOnlyTransport = isTextOnlyRealtimeModalities(nextPrompt.modalities);
      const wasSent = shouldUseTextOnlyTransport
        ? sendOpenAITextPromptOverWebSocket(nextPrompt.prompt, nextPrompt.modalities, nextPrompt.metadata)
        : sendOpenAITextPrompt(nextPrompt.prompt, nextPrompt.modalities, nextPrompt.metadata);
      if (!wasSent) {
        openaiPendingPromptRef.current.unshift(nextPrompt);
        return;
      }
    }
  }

  const queueOpenAITextPrompt = useCallback(async (
    prompt: string,
    requestedModalities?: RealtimeResponseModality[],
    metadata?: OpenAIPromptMetadata,
  ) => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) return false;

    const modalities = normalizeRealtimeModalities(requestedModalities);
    if (isTextOnlyRealtimeModalities(modalities)) {
      if (sendOpenAITextPromptOverWebSocket(trimmedPrompt, modalities, metadata)) {
        return true;
      }

      openaiPendingPromptRef.current.push({ prompt: trimmedPrompt, modalities, metadata });

      await connectOpenAITextRealtime();
      return true;
    }

    if (sendOpenAITextPrompt(trimmedPrompt, modalities, metadata)) {
      return true;
    }

    openaiPendingPromptRef.current.push({ prompt: trimmedPrompt, modalities, metadata });

    if (!openaiPcRef.current && !isOpenAIConnected) {
      await connectOpenAIRealtime();
    }

    return true;
  }, [
    connectOpenAIRealtime,
    isOpenAIConnected,
    sendOpenAITextPrompt,
    sendOpenAITextPromptOverWebSocket,
  ]);

  const replayPendingSensitiveRealtimePrompt = useCallback(async () => {
    const pendingPrompt = pendingSensitiveRealtimeUnlockPromptRef.current;
    if (!pendingPrompt || !voiceFinancialAccessUnlocked) {
      return false;
    }

    pendingSensitiveRealtimeUnlockPromptRef.current = null;
    await loadAssistantCanonicalContext();
    setVoiceIdentityMessage(
      touchIdFinancialAccessUnlocked
        ? 'Touch ID verified. Answering your private financial question now.'
        : 'Verified speaker matched. Answering your private financial question now.',
    );
    await queueOpenAITextPrompt(pendingPrompt.prompt, pendingPrompt.modalities, pendingPrompt.metadata);
    return true;
  }, [
    loadAssistantCanonicalContext,
    queueOpenAITextPrompt,
    touchIdFinancialAccessUnlocked,
    voiceFinancialAccessUnlocked,
  ]);

  useEffect(() => {
    void replayPendingSensitiveRealtimePrompt();
  }, [replayPendingSensitiveRealtimePrompt]);

  function sendOpenAISessionUpdate(
    transport: OpenAIMessageTransport,
    options: { force?: boolean } = {},
  ) {
    const currentScreenContext = screenContextRef.current;
    const currentUserData = userDataRef.current;
    const dashboardContext = dashboardContextRef.current;
    const assistantCanonicalContext = assistantCanonicalContextRef.current;
    const assistantMemoryContext = formatAssistantMemoryForPrompt(assistantMemoryRef.current);
    const isAudioTransport = transport.kind === 'audio';
    const outputModalities = transport.kind === 'text'
      || isTextOnlyRealtimeModalities(lastOpenAIResponseModalitiesRef.current)
      ? ['text']
      : ['audio'];

    let contextInfo = `\n\nCURRENT CONTEXT:\n- Current page: ${currentScreenContext.currentPage}\n- Page title: ${currentScreenContext.pageTitle}`;
    const liveScreenContext = formatScreenContextForAI(currentScreenContext);
    if (liveScreenContext) {
      contextInfo += `\n\nLIVE SCREEN CONTEXT (what the user is looking at right now):\n${liveScreenContext}`;
    }
    if (assistantCanonicalContext) {
      contextInfo += `\n\n${assistantCanonicalContext}`;
    } else {
      if (voiceFinancialAccessUnlocked) {
        contextInfo += touchIdFinancialAccessUnlocked
          ? '\n\nFINANCIAL ACCESS:\n- Touch ID verified for this session.'
          : `\n\nFINANCIAL VOICE ACCESS:\n- Verified until ${voiceFinancialUnlockLabel || 'soon'} for the enrolled speaker.`;
        contextInfo += buildVoiceFinancialContext(currentUserData);
      } else {
        contextInfo += hasVoiceEnrollment
          ? '\n\nFINANCIAL VOICE ACCESS:\n- Enrolled speaker samples exist.\n- Status: checking the live voice in the background.\n- Refuse to summarize or discuss transactions, bookkeeping, tax documents, net worth, balances, holdings, or other private financial details until the app explicitly marks the enrolled speaker as verified. If the user asks early, explain that background speaker checking is still in progress and do not mention any manual unlock step.'
          : '\n\nFINANCIAL VOICE ACCESS:\n- No enrolled speaker samples exist yet.\n- Refuse to summarize or discuss transactions, bookkeeping, tax documents, net worth, balances, holdings, or other private financial details. Tell the user they can use Touch ID on this device or add voice samples first.';
      }
      if (currentUserData?.sensors) {
        contextInfo += `\n\nSENSOR DATA:\n- Total: ${currentUserData.sensors.totalSensors}, Online: ${currentUserData.sensors.onlineSensors}, Alerts: ${currentUserData.sensors.activeAlertCount}`;
      }
    }
    contextInfo += assistantMemoryContext;

    if (currentScreenContext.currentPage?.includes('/sensors')) {
      const analyticsCtx = (typeof window !== 'undefined'
        ? (window as unknown as { __houseyieldSensorAnalyticsContext?: Record<string, unknown> }).__houseyieldSensorAnalyticsContext
        : null);
      if (analyticsCtx) {
        contextInfo += `\n\nSENSOR ANALYTICS CONTEXT (live on-screen data — use this when explaining Analytics):\n${JSON.stringify(analyticsCtx)}`;
      } else {
        contextInfo += `\n\nPREDICTIVE MAINTENANCE CONTROLS:\n- Tabs: sensor-tab-overview, sensor-tab-alerts, sensor-tab-analytics\n- Analytics layers (after opening Analytics): sensor-layer-conditions, sensor-layer-mold, sensor-layer-freeze, sensor-layer-insulation\n- Prefer click_element for those ids, or execute_site_action open-sensor-analytics / analyze-sensor-data with view and layer.`;
      }
    }

    const availablePages = [...listAssistantNavigablePageKeys()];

    const realtimeTools: Array<Record<string, unknown>> = [
      {
        type: 'function',
        name: 'navigate_to_page',
        description: 'Navigate the user to a page',
        parameters: {
          type: 'object',
          properties: { page: { type: 'string', enum: availablePages } },
          required: ['page']
        }
      },
      {
        type: 'function',
        name: 'highlight_element',
        description: 'Visually highlight a UI element by data-voice-id without clicking it',
        parameters: {
          type: 'object',
          properties: { element_id: { type: 'string' } },
          required: ['element_id']
        }
      },
      {
        type: 'function',
        name: 'click_element',
        description: 'Click a visible control by data-voice-id. Use this for Predictive Maintenance tabs (sensor-tab-overview, sensor-tab-alerts, sensor-tab-analytics) and analytics layers (sensor-layer-conditions, sensor-layer-mold, sensor-layer-freeze, sensor-layer-insulation). Prefer execute_site_action open-sensor-analytics / analyze-sensor-data / open-platform-workspace when navigating from another page.',
        parameters: {
          type: 'object',
          properties: {
            element_id: {
              type: 'string',
              description: 'data-voice-id of the control to click',
            },
          },
          required: ['element_id'],
        },
      },
      {
        type: 'function',
        name: 'execute_site_action',
        description: 'Execute any HouseYield landlord workflow end-to-end. Prefer this for real work across the whole platform — not just analysis. Management: set-tenant-rent-rate, send-late-payment-alert, draft-tenant-message, create-document / create-lease-agreement, list-documents (preferred for OPEN/FIND/SHOW existing pet addendums, leases, or other documents), request-document-esignature, edit-document, schedule-ai-task, list-scheduled-ai-tasks, follow-up-esignature-request, draft-contractor-payment-receipt, download-irs-tax-file, add-bookkeeping-transaction, show-bookkeeping-expenses, follow-up-maintenance-request, book-maintenance-provider, add-property, add-tenant, add-sensor, open-platform-workspace, open-sensor-analytics. Analysis: analyze-property (preferred for ANY named-property ask), analyze-market-insight, analyze-sensor-data. When the owner asks to open/find/show an existing document (especially pet addendum), ALWAYS use list-documents with propertyAddress + documentType — never say none exist without that lookup. For Predictive Maintenance navigation or chart questions, use open-platform-workspace with sensors_analytics / sensors_alerts / sensors_overview, or analyze-sensor-data with view + layer. For property questions (overview, analytics, refinance/cash-out, rental pricing power / rent reset, environmental / flood / wildfire risk, or full review), ALWAYS use analyze-property with propertyAddress and analysisType so the task pad opens with metrics and the matching Properties workspace deep-links. Backend-first actions navigate the owner, do the work, and show an interactive result in the task pad — never leave mom-and-pop owners hunting through menus. For mortgage interest, management fees, or ledger category/year/property questions, use show-bookkeeping-expenses with category + year + propertyAddress and read speakableAnswer aloud. For creating NEW documents, pass documentType and requestEsignature:true when they want signatures. For schedule-ai-task, pass the user\'s exact time phrase in when and do NOT invent ISO runAt. Never draft mailto for tenants — use draft-tenant-message / tenant portal.',
        parameters: {
          type: 'object',
          properties: {
            actionId: {
              type: 'string',
              description: 'Registered action id such as analyze-property, open-platform-workspace, open-sensor-analytics, list-documents, create-document, create-lease-agreement, request-document-esignature, edit-document, draft-tenant-message, schedule-ai-task, list-scheduled-ai-tasks, set-tenant-rent-rate, send-late-payment-alert, download-irs-tax-file, show-bookkeeping-expenses, book-maintenance-provider, analyze-market-insight, analyze-sensor-data.',
            },
            parameters: {
              type: 'object',
              description: 'Structured parameters for the action.',
              properties: {
                requestSummary: { type: 'string', description: 'Short summary of what the user asked for.' },
                customInstructions: { type: 'string', description: 'Extra lease/document requirements.' },
                propertyId: { type: 'string' },
                propertyAddress: { type: 'string' },
                analysisType: {
                  type: 'string',
                  description: 'For analyze-property: overview | analytics | refinance | rental_pricing | environmental_risk | full. Infer from the user ask.',
                },
                targetRent: {
                  type: 'number',
                  description: 'For analyze-property rental_pricing: optional asking rent to evaluate with the same vacancy-risk calculator as the Rental Pricing Power slider (e.g. 4800).',
                },
                askingRent: {
                  type: 'number',
                  description: 'Alias for targetRent — vacancy at this monthly rent.',
                },
                workspaceId: {
                  type: 'string',
                  description: 'For open-platform-workspace: documents | tenants | maintenance | bookkeeping | tax | sensors | sensors_analytics | sensors_alerts | sensors_overview | market | renovations | portfolio_overview | portfolio_properties. Use sensors_analytics for Predictive Maintenance Analytics.',
                },
                view: {
                  type: 'string',
                  description: 'For analyze-sensor-data: overview | alerts | analytics.',
                },
                layer: {
                  type: 'string',
                  description: 'For Predictive Maintenance Analytics: conditions | mold | freeze | insulation.',
                },
                tenantId: { type: 'string' },
                tenantName: { type: 'string' },
                monthlyRent: { type: 'number', description: 'New monthly rent for set-tenant-rent-rate.' },
                amountDue: { type: 'number' },
                dueDate: { type: 'string' },
                amount: { type: 'number', description: 'Amount for bookkeeping or receipts.' },
                memo: { type: 'string', description: 'Bookkeeping description.' },
                category: { type: 'string' },
                isExpense: { type: 'boolean' },
                taxYear: { type: 'number' },
                year: { type: 'number', description: 'Tax year / bookkeeping year (e.g. 2025) for Schedule E or show-bookkeeping-expenses.' },
                startDate: { type: 'string', description: 'Optional YYYY-MM-DD start for bookkeeping range.' },
                endDate: { type: 'string', description: 'Optional YYYY-MM-DD end for bookkeeping range.' },
                documentId: { type: 'string' },
                documentType: { type: 'string', description: 'For list-documents or create-document: LEASE_AGREEMENT, PET_ADDENDUM, LEASE_AMENDMENT, MOVE_IN_CHECKLIST, MOVE_OUT_CHECKLIST, NOTICE_TO_VACATE, NOTICE_TO_QUIT, RENT_INCREASE_NOTICE, MAINTENANCE_AUTHORIZATION, CUSTOM_DOCUMENT.' },
                requestEsignature: { type: 'boolean', description: 'When true for create-document, create a real e-signature request after saving.' },
                sendForSignature: { type: 'boolean' },
                instructions: { type: 'string', description: 'Voice/text edit instructions for edit-document.' },
                body: { type: 'string', description: 'Message body for draft-tenant-message.' },
                subject: { type: 'string' },
                autoSend: { type: 'boolean', description: 'When true for draft-tenant-message, send immediately through the tenant portal without waiting for a pad click.' },
                title: { type: 'string', description: 'Title for schedule-ai-task.' },
                when: { type: 'string', description: 'Natural-language schedule time, e.g. Monday at 2pm or Friday at 3pm.' },
                notes: { type: 'string', description: 'Notes/details for a scheduled AI task.' },
                linkedActionId: { type: 'string', description: 'Optional action to run when the scheduled task is due.' },
                vendorName: { type: 'string' },
                contractorName: { type: 'string' },
                issue: { type: 'string', description: 'Maintenance issue description.' },
                requestId: { type: 'string' },
                autoGenerate: { type: 'boolean' },
                autoBook: { type: 'boolean' },
                forceRefresh: { type: 'boolean' },
                address: { type: 'string' },
                location: { type: 'string' },
              },
            },
          },
          required: ['actionId'],
        },
      },
      {
        type: 'function',
        name: 'lookup_platform_data',
        description: 'Look up exact scoped platform data for the authenticated user. Use summarize_account_data first when you need account-wide coverage, get_field for one Firestore value, scoped collection queries for Firebase records, and query_azure_ledger for live Azure bookkeeping totals (mortgage interest, management fees, category breakdowns by year/property). Never request data outside the authenticated account.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['summarize_account_data', 'list_accessible_collections', 'list_subcollections', 'get_document', 'get_field', 'query_collection', 'query_collection_group', 'query_azure_ledger'],
            },
            documentPath: {
              type: 'string',
              description: 'Firestore document path like users/{uid} or properties/{propertyId}/leases/{leaseId}. Required for get_document, get_field, and list_subcollections.',
            },
            fieldPath: {
              type: 'string',
              description: 'Dot-separated nested field path like financials.monthlyRent or units.0.status. Required for get_field.',
            },
            collectionPath: {
              type: 'string',
              description: 'Firestore collection path like properties or users/{uid}/documents. Required for query_collection. Do not use this for Azure ledger totals — use query_azure_ledger instead.',
            },
            collectionGroup: {
              type: 'string',
              description: 'Collection group id like transactions or entries. Required for query_collection_group.',
            },
            propertyId: {
              type: 'string',
              description: 'Optional property id for query_azure_ledger.',
            },
            propertyAddress: {
              type: 'string',
              description: 'Optional property address for query_azure_ledger.',
            },
            year: {
              type: 'number',
              description: 'Optional tax year for query_azure_ledger (e.g. 2025).',
            },
            taxYear: {
              type: 'number',
            },
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            category: {
              type: 'string',
              description: 'Ledger category filter for query_azure_ledger, e.g. mortgage interest or management fees.',
            },
            address: { type: 'string' },
            filters: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  op: { type: 'string', enum: ['==', '!=', '<', '<=', '>', '>=', 'array-contains', 'array-contains-any', 'in', 'not-in'] },
                  value: {},
                },
                required: ['field', 'op', 'value'],
              },
            },
            orderBy: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  direction: { type: 'string', enum: ['asc', 'desc'] },
                },
                required: ['field'],
              },
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
            },
          },
          required: ['action'],
        }
      },
      {
        type: 'function',
        name: 'compute_portfolio_metric',
        description: 'Compute a financial metric (NOI, cash flow, cap rate, gross rent, operating expenses, expense breakdown, debt service, equity, or portfolio summary) with its full derivation from canonical property and bookkeeping data. Use this instead of telling the user to check a card. For specific ledger categories like mortgage interest or management fees, prefer show-bookkeeping-expenses or lookup_platform_data query_azure_ledger.',
        parameters: {
          type: 'object',
          properties: {
            metric: {
              type: 'string',
              enum: ['noi', 'cash_flow', 'cap_rate', 'gross_rent', 'operating_expenses', 'expense_breakdown', 'debt_service', 'equity', 'portfolio_summary'],
            },
            propertyId: {
              type: 'string',
              description: 'Optional property id or address to scope the metric to one property. Omit for portfolio-wide.',
            },
            year: {
              type: 'number',
              description: 'Optional tax/calendar year to filter Azure ledger category totals (e.g. 2025).',
            },
          },
          required: ['metric'],
        },
      },
      {
        type: 'function',
        name: 'google_search',
        description: 'Search public web results for timely macro, company, or local market information when HouseYield context does not already contain the latest public update.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'A focused public web query such as a company name plus news topic or a macro topic like Federal Reserve mortgage rate news.',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
            },
          },
          required: ['query'],
        }
      }
    ];

    if (dashboardContext?.enabled && Array.isArray(dashboardContext.availableSurfaces) && dashboardContext.availableSurfaces.length > 0) {
      const currentSurfaceList = Array.isArray(dashboardContext.currentSurfaceIds) && dashboardContext.currentSurfaceIds.length > 0
        ? dashboardContext.currentSurfaceIds.join(', ')
        : 'none';
      const surfaceIds = dashboardContext.availableSurfaces.map((surface) => surface.id);
      const surfaceList = dashboardContext.availableSurfaces.map((surface) => `${surface.id} (${surface.title})`).join(', ');
      const currentSurfaceLayouts = Array.isArray(dashboardContext.currentSurfaceLayouts) && dashboardContext.currentSurfaceLayouts.length > 0
        ? dashboardContext.currentSurfaceLayouts.map((layout) => `${layout.id}[x:${layout.x ?? 0}, y:${layout.y ?? 0}, w:${layout.w ?? 0}, h:${layout.h ?? 0}${layout.emphasis ? ', emphasis' : ''}]`).join(', ')
        : 'default';
      const actionList = Array.isArray(dashboardContext.availableActions) && dashboardContext.availableActions.length > 0
        ? dashboardContext.availableActions.map((action) => `${action.id} (${action.name})`).join(', ')
        : 'none';
      const annotationPlacements = Array.isArray(dashboardContext.annotationPlacements) && dashboardContext.annotationPlacements.length > 0
        ? dashboardContext.annotationPlacements
        : DEFAULT_DASHBOARD_ANNOTATION_PLACEMENTS;
      const annotationTones = Array.isArray(dashboardContext.annotationTones) && dashboardContext.annotationTones.length > 0
        ? dashboardContext.annotationTones
        : DEFAULT_DASHBOARD_ANNOTATION_TONES;
      const annotationWidths = Array.isArray(dashboardContext.annotationWidths) && dashboardContext.annotationWidths.length > 0
        ? dashboardContext.annotationWidths
        : DEFAULT_DASHBOARD_ANNOTATION_WIDTHS;

      const propertyBreakdownText = voiceFinancialAccessUnlocked && Array.isArray(dashboardContext.propertyValueBreakdown) && dashboardContext.propertyValueBreakdown.length > 0
        ? (dashboardContext.propertyValueBreakdown as Array<{ key: string; label: string; percent: number; value: number }>).map((s) => `${s.label}(key:${s.key}, ${s.percent.toFixed(1)}%, $${Math.round(s.value).toLocaleString()})`).join(', ')
        : '';
      const totalPropertyValueText = voiceFinancialAccessUnlocked && typeof dashboardContext.totalPropertyValue === 'number'
        ? `$${Math.round(dashboardContext.totalPropertyValue).toLocaleString()}`
        : '';
      const propertyCashFlowText = voiceFinancialAccessUnlocked && Array.isArray(dashboardContext.propertyCashFlowSnapshots) && dashboardContext.propertyCashFlowSnapshots.length > 0
        ? dashboardContext.propertyCashFlowSnapshots
          .slice(0, 6)
          .map((snapshot) => `${snapshot.surfaceId} for ${snapshot.propertyLabel}: ${snapshot.yearlyValues.map((point) => `${point.year}:${point.formatted}`).join(', ')}`)
          .join('\n- ')
        : '';
      const lastHighlightText = (dashboardContext.lastHighlightedSurfaceId as string | null)
        ? `Last focused card: ${dashboardContext.lastHighlightedSurfaceId}`
        : '';
      const dashboardModeRule = isAudioTransport
        ? 'RULE — for spoken replies, answer directly by default. Only call control_dashboard when the user explicitly asks to show, highlight, move, annotate, compare visually, or otherwise change the dashboard, or when a visual change is required to complete the request.'
        : 'RULE — call control_dashboard on EVERY answer when on the dashboard, even follow-ups. Never reply text-only when visual output is possible.';
      const dashboardDataRule = isAudioTransport
        ? 'RULE — for spoken answers that mention visible dashboard data, you may answer without a tool call unless the user asks for an on-screen change. If you do call control_dashboard, set highlightId to the relevant card and add at least one annotation containing your answer text.'
        : 'RULE — for any answer that references a visible card\'s data, set highlightId to that card and add at least one annotation containing your answer text.';

      contextInfo += `\n\nDASHBOARD CONTROL CONTEXT:\n${dashboardModeRule}\n${dashboardDataRule}\nRULE — for follow-up questions on the same topic, keep the card visible, set emphasis:true on its layout entry, and add a NEW annotation. Set clearAnnotations:false to layer bubbles.\nRULE — prefer mode:"annotate" or mode:"arrange" for follow-up questions so the card stays and you only update annotations/highlights.\n- Scene width: ${DEFAULT_DASHBOARD_SCENE_WIDTH}px. Use layout x/y/w/h/zIndex for fluid placement.\n- Current dashboard cards: ${currentSurfaceList}\n- Current dashboard layout: ${currentSurfaceLayouts}\n- Available surface ids: ${surfaceList}\n- Available action ids: ${actionList}\n- Annotation placements: ${annotationPlacements.join(', ')}\n- Annotation tones: ${annotationTones.join(', ')}\n- Annotation widths: ${annotationWidths.join(', ')}\n- Annotation x/y are % (0-100) within canvas or card. Add arrow:"up"|"down"|"left"|"right" to point toward a chart element.\n- Property count: ${dashboardContext.propertyCount || 0}, transactions: ${voiceFinancialAccessUnlocked ? dashboardContext.transactionCount || 0 : 'redacted'}, devices: ${dashboardContext.maintenanceDeviceCount || 0}${totalPropertyValueText ? `\n- Total property value: ${totalPropertyValueText}` : ''}${propertyBreakdownText ? `\n- Property value breakdown: ${propertyBreakdownText}` : ''}${propertyCashFlowText ? `\n- Visible cash flow projections:\n- ${propertyCashFlowText}` : ''}${lastHighlightText ? `\n- ${lastHighlightText}` : ''}`;

      realtimeTools.push({
        type: 'function',
        name: 'control_dashboard',
        description: 'Update dashboard layout, move and resize cards on a coordinate-based scene canvas, add explanatory text boxes, highlight a dashboard card, or trigger a dashboard workflow action.',
        parameters: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['add', 'replace', 'remove', 'clear', 'reset', 'arrange', 'annotate'] },
            surfaces: {
              type: 'array',
              items: { type: 'string', enum: surfaceIds },
              description: 'Dashboard surface ids to add, replace, or remove.',
            },
            layout: {
              type: 'array',
              description: 'Optional surface layout overrides for moving, resizing, layering, emphasizing, showing, or hiding cards. Prefer x/y/w/h/zIndex for fluid placement on the desktop scene. Legacy order/size/height fields remain supported.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', enum: surfaceIds },
                  visible: { type: 'boolean' },
                  order: { type: 'integer' },
                  size: { type: 'string', enum: DEFAULT_DASHBOARD_SURFACE_SIZES },
                  height: { type: 'string', enum: DEFAULT_DASHBOARD_SURFACE_HEIGHTS },
                  x: { type: 'integer', description: `Desktop scene x position in a ${DEFAULT_DASHBOARD_SCENE_WIDTH}px-wide virtual canvas.` },
                  y: { type: 'integer', description: 'Desktop scene y position in pixels.' },
                  w: { type: 'integer', description: 'Desktop scene width in pixels.' },
                  h: { type: 'integer', description: 'Desktop scene height in pixels.' },
                  zIndex: { type: 'integer', description: 'Higher values appear above lower values when cards overlap.' },
                  emphasis: { type: 'boolean' },
                },
                required: ['id'],
              },
            },
            annotations: {
              type: 'array',
              description: 'Explanatory text bubbles. Attach to a card (surfaceId) or float on the canvas. Use x/y to position precisely. Use arrow to point toward a chart element.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  text: { type: 'string' },
                  surfaceId: { type: 'string', enum: surfaceIds },
                  placement: { type: 'string', enum: annotationPlacements },
                  tone: { type: 'string', enum: annotationTones },
                  width: { type: 'string', enum: annotationWidths },
                  x: { type: 'number', description: 'Relative x % (0-100) inside canvas or card.' },
                  y: { type: 'number', description: 'Relative y % (0-100) inside canvas or card.' },
                  arrow: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Direction of pointer arrow on the bubble, pointing toward the element being described.' },
                  persistent: { type: 'boolean' },
                },
                required: ['text'],
              },
            },
            clearAnnotations: {
              type: 'boolean',
              description: 'Set true to clear previous annotations before adding new ones. Set false (default) to layer new annotations on top of existing ones.',
            },
            segmentHighlights: {
              type: 'array',
              description: 'Dim non-relevant segments inside a card chart. Use to spotlight a specific slice or bar when a card supports segment highlighting. Pass an empty array to clear highlights.',
              items: {
                type: 'object',
                properties: {
                  surfaceId: { type: 'string', enum: surfaceIds, description: 'Which card to apply segment dimming to.' },
                  keys: { type: 'array', items: { type: 'string' }, description: 'The segment keys to keep fully visible. All other segments will be dimmed.' },
                },
                required: ['surfaceId', 'keys'],
              },
            },
            highlightId: {
              type: 'string',
              description: 'Surface id to ring-highlight. Always set this when answering a question about a specific card.',
            },
            actionId: {
              type: 'string',
              description: 'Optional workflow action id to trigger after the dashboard update.',
            },
            message: {
              type: 'string',
              description: 'Brief operational summary of the dashboard change.',
            },
            answer: {
              type: 'string',
              description: 'Two to four sentences answering the user. Required for any explanation or follow-up question — never leave this empty for data questions.',
            },
          },
          required: ['mode', 'message'],
        },
      });
    }

    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: outputModalities,
        audio: transport.kind === 'audio'
          ? {
              input: {
                turn_detection: {
                  type: 'server_vad',
                  // Slightly higher than default so speaker playback is less likely
                  // to be heard as a new user turn, while real interruptions still work.
                  threshold: 0.72,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 800,
                  create_response: true,
                  // Let OpenAI interrupt itself when the owner truly talks over it.
                  interrupt_response: true,
                },
              },
            }
          : undefined,
        reasoning: transport.kind === 'audio' ? { effort: 'low' } : undefined,
        instructions: `You are HouseYield's landlord assistant. Be warm and plain-spoken.

RESPONSE CONTRACT:
- Answer the question directly in a short paragraph. Do NOT say "highlights", "key highlights", "here are the highlights", or open with an overview bullet list.
- After the direct answer, you may add at most 2 short follow-up facts if they help — spoken as normal sentences, not labeled as highlights.
- Put longer detail in the task pad, not in speech.
- Prefer tools over deflection: never tell the owner to go dig for a number you can fetch or compute.
- For greetings/small talk, reply briefly with no tools.
- Use navigate_to_page only when the user asks to go somewhere and no workflow fits.
- Prefer execute_site_action for real work (analyze-property, show-bookkeeping-expenses, create-document, draft-tenant-message, schedule-ai-task, open-platform-workspace, open-sensor-analytics, analyze-sensor-data, etc.).
- Predictive Maintenance (/sensors): to open Overview / Alerts / Analytics use execute_site_action with open-platform-workspace (workspaceId sensors_overview | sensors_alerts | sensors_analytics) or analyze-sensor-data with view/layer. When already on the page, click_element on sensor-tab-overview, sensor-tab-alerts, sensor-tab-analytics, or sensor-layer-mold / freeze / insulation / conditions. When SENSOR ANALYTICS CONTEXT is present, use those live numbers to explain the charts — do not invent readings.
- Use compute_portfolio_metric / lookup_platform_data / google_search when needed for exact numbers or news.
- Named-property asks → analyze-property with propertyAddress + analysisType.
- Year-scoped collected income → show-bookkeeping-expenses / query_azure_ledger, not modeled rent × 12.
- When dashboard control context is present in text mode, call control_dashboard for visual answers (highlightId + annotation). In voice mode, speak first and only update the dashboard when a visual change is needed.
- Reuse memory quietly for personalization; never invent account data outside this authenticated user.

${contextInfo}

AVAILABLE PAGES: ${availablePages.join(', ')}`,
        tools: realtimeTools,
        tool_choice: 'auto'
      }
    };

    // Deduplicate identical session updates — the old effect re-sent this on every
    // React re-render (~60fps while the orb spoke) and chopped the audio stream.
    // Also skip while a response is actively speaking/generating so we don't
    // cut the model mid-sentence with a session.update storm.
    if (
      !options.force
      && openAIResponseInFlightRef.current
      && transport.kind === 'audio'
    ) {
      return;
    }
    const updateKey = JSON.stringify({
      kind: transport.kind,
      outputModalities,
      page: currentScreenContext.currentPage,
      pageTitle: currentScreenContext.pageTitle,
      hasDashboard: Boolean(dashboardContext),
      memoryLen: assistantMemoryContext.length,
      canonicalLen: assistantCanonicalContext.length,
      instructionsLen: String(sessionUpdate.session.instructions || '').length,
      toolCount: realtimeTools.length,
      vad: isAudioTransport ? sessionUpdate.session.audio?.input?.turn_detection : null,
    });
    const now = Date.now();
    if (
      !options.force
      && updateKey === lastOpenAISessionUpdateKeyRef.current
      && now - lastOpenAISessionUpdateAtRef.current < 2500
    ) {
      return;
    }
    lastOpenAISessionUpdateKeyRef.current = updateKey;
    lastOpenAISessionUpdateAtRef.current = now;
    transport.send(JSON.stringify(sessionUpdate));
  }

  function scheduleOpenAISessionUpdate(transport: OpenAIMessageTransport, { force = false, delayMs = 450 }: { force?: boolean; delayMs?: number } = {}) {
    if (force) {
      if (openAISessionUpdateTimerRef.current) {
        window.clearTimeout(openAISessionUpdateTimerRef.current);
        openAISessionUpdateTimerRef.current = null;
      }
      sendOpenAISessionUpdate(transport, { force: true });
      return;
    }

    if (openAISessionUpdateTimerRef.current) {
      window.clearTimeout(openAISessionUpdateTimerRef.current);
    }
    openAISessionUpdateTimerRef.current = window.setTimeout(() => {
      openAISessionUpdateTimerRef.current = null;
      sendOpenAISessionUpdate(transport);
    }, delayMs);
  }

  async function connectOpenAITextRealtime() {
    const existingSocket = openaiTextWsRef.current;
    if (existingSocket && (
      existingSocket.readyState === WebSocket.OPEN
      || existingSocket.readyState === WebSocket.CONNECTING
    )) {
      return;
    }

    try {
      setIsProcessing(true);
      await Promise.all([
        loadAssistantMemorySnapshot(),
        loadAssistantCanonicalContext(),
      ]);
      const headers = await getAuthenticatedRealtimeHeaders();
      const tokenResponse = await fetch(`${baseUrl}/api/openai/realtime-token`, {
        method: 'POST',
        headers,
      });

      if (!tokenResponse.ok) {
        const err = await tokenResponse.json();
        throw new Error(err.error || 'Failed to get realtime token');
      }

      const { token, url } = await tokenResponse.json();
      const ws = new WebSocket(url, ['realtime', `openai-insecure-api-key.${token}`]);
      const textTransport: OpenAIMessageTransport = {
        kind: 'text',
        send: (data) => ws.send(data),
      };

      openaiTextWsRef.current = ws;

      ws.onopen = () => {
        setIsProcessing(false);
        sendOpenAISessionUpdate(textTransport);
        flushPendingOpenAIPrompts();
      };

      ws.onmessage = (event) => {
        try {
          handleOpenAIEvent(JSON.parse(event.data), textTransport);
        } catch (error) {
          console.error('[OpenAI Realtime Text] Message parse error:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('[OpenAI Realtime Text] WebSocket error:', error);
        setIsProcessing(false);
      };

      ws.onclose = () => {
        if (openaiTextWsRef.current === ws) {
          openaiTextWsRef.current = null;
        }
        void persistAssistantMemory('disconnect');
        resetAssistantMemoryTracking();
        openaiTextResponseRef.current = '';
        setIsProcessing(false);
      };
    } catch (error) {
      console.error('[OpenAI Realtime Text] Connection failed:', error);
      const queuedPrompts = openaiPendingPromptRef.current.splice(0);
      queuedPrompts.forEach((queuedPrompt) => {
        dispatchDashboardRealtimeResponse(
          'Sorry, I could not connect to the realtime assistant.',
          { prompt: queuedPrompt.prompt, ...(queuedPrompt.metadata || {}) },
          'realtime_connect_failed',
        );
      });
      setIsProcessing(false);
      disconnectOpenAITextRealtime();
    }
  }

  const finalizeOpenAITextResponse = (finalText?: string, responseId?: string | null) => {
    const resolvedResponseId = responseId || activeOpenAIResponseIdRef.current;
    if (resolvedResponseId && finalizedOpenAIResponseIdsRef.current.has(resolvedResponseId)) {
      return;
    }
    if (resolvedResponseId) {
      finalizedOpenAIResponseIdsRef.current.add(resolvedResponseId);
      if (finalizedOpenAIResponseIdsRef.current.size > 40) {
        const oldest = finalizedOpenAIResponseIdsRef.current.values().next().value;
        if (oldest) finalizedOpenAIResponseIdsRef.current.delete(oldest);
      }
    }

    const fallbackText = lastOpenAIFunctionResultRef.current
      || (activeOpenAIPromptMetaRef.current?.source === 'dashboard' ? 'Updated the dashboard.' : '');
    const text = (finalText || openaiTextResponseRef.current || fallbackText || '').trim();
    if (!text) {
      setIsProcessing(false);
      setOpenaiTranscript('');
      return;
    }

    if (pendingSensitivePassiveReplayRef.current && isLikelyFinancialVoiceLockResponse(text)) {
      openaiTextResponseRef.current = '';
      activeOpenAIPromptMetaRef.current = null;
      lastOpenAIFunctionResultRef.current = '';
      setOpenaiTranscript('');
      setIsProcessing(false);
      setIsSpeaking(false);
      return;
    }

    appendConversationMessage({
      role: 'assistant',
      content: text,
      timestamp: new Date(),
    });
    dispatchDashboardRealtimeResponse(text);
    openaiTextResponseRef.current = '';
    activeOpenAIPromptMetaRef.current = null;
    lastOpenAIFunctionResultRef.current = '';
    setOpenaiTranscript('');
    setIsProcessing(false);
    setIsSpeaking(false);
  };

  const handleOpenAIEvent = (event: any, transport: OpenAIMessageTransport) => {
    openAIActiveTransportRef.current = transport;
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        break;
      case 'input_audio_buffer.speech_started':
        setIsListening(true);
        pendingPassiveVoiceSampleRef.current = null;
        pendingPassiveVoiceTranscriptRef.current = '';
        voiceIdentityLiveCaptureRef.current?.beginSegment();
        break;
      case 'input_audio_buffer.speech_stopped':
        if (voiceIdentityLiveCaptureRef.current?.isSegmentActive()) {
          pendingPassiveVoiceSampleRef.current = voiceIdentityLiveCaptureRef.current.endSegment();
          flushPendingPassiveVoiceVerification();
        }
        break;
      case 'response.created':
        openAIResponseInFlightRef.current = true;
        processedOpenAIFunctionCallIdsRef.current.clear();
        activeOpenAIResponseIdRef.current = event.response?.id || event.response_id || null;
        openaiAudioStartedRef.current = false;
        openaiAudioTranscriptBufferRef.current = '';
        openaiTextResponseRef.current = '';
        setOpenaiTranscript('');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        setTranscript(event.transcript);
        appendConversationMessage({
          role: 'user',
          content: event.transcript,
          timestamp: new Date()
        });
        pendingPassiveVoiceTranscriptRef.current = typeof event.transcript === 'string' ? event.transcript : '';
        if (
          isSensitiveFinancialVoiceIntent(pendingPassiveVoiceTranscriptRef.current)
          && !voiceFinancialAccessUnlocked
          && Boolean(voiceIdentityStatus?.hasEnrollment)
          && Date.now() - lastPassiveVoiceVerifyAtRef.current > 5000
        ) {
          pendingSensitivePassiveReplayRef.current = pendingPassiveVoiceTranscriptRef.current;
          setVoiceIdentityMessage('Checking your live voice automatically for this financial question...');
        }
        flushPendingPassiveVoiceVerification();
        break;
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta': {
        const nextTranscript = openaiAudioTranscriptBufferRef.current + (event.delta || '');
        openaiAudioTranscriptBufferRef.current = nextTranscript;
        if (openaiAudioStartedRef.current) {
          setOpenaiTranscript(nextTranscript);
        }
        break;
      }
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
        const audioResponseId = event.response_id || activeOpenAIResponseIdRef.current;
        if (
          pendingSensitivePassiveReplayRef.current
          && isLikelyFinancialVoiceLockResponse(typeof event.transcript === 'string' ? event.transcript : '')
        ) {
          openaiAudioTranscriptBufferRef.current = '';
          setOpenaiTranscript('');
          break;
        }
        if (audioResponseId && finalizedOpenAIResponseIdsRef.current.has(audioResponseId)) {
          openaiAudioTranscriptBufferRef.current = '';
          setOpenaiTranscript('');
          break;
        }
        if (typeof event.transcript === 'string' && event.transcript.trim()) {
          if (audioResponseId) {
            finalizedOpenAIResponseIdsRef.current.add(audioResponseId);
          }
          appendConversationMessage({
            role: 'assistant',
            content: event.transcript,
            timestamp: new Date()
          });
        }
        openaiAudioTranscriptBufferRef.current = '';
        setOpenaiTranscript('');
        break;
      }
      case 'response.audio.done':
      case 'response.output_audio.done':
        // Audio packets may finish before the element drains — delay speaking=false.
        if (openAISpeakingStopTimerRef.current) {
          window.clearTimeout(openAISpeakingStopTimerRef.current);
        }
        openAISpeakingStopTimerRef.current = window.setTimeout(() => {
          openaiAudioStartedRef.current = false;
          setIsSpeaking(false);
          openAISpeakingStopTimerRef.current = null;
        }, 280);
        break;
      case 'response.text.delta':
      case 'response.output_text.delta':
        openaiTextResponseRef.current += event.delta || '';
        setOpenaiTranscript(prev => prev + (event.delta || ''));
        setIsProcessing(false);
        break;
      case 'response.text.done':
      case 'response.output_text.done':
        finalizeOpenAITextResponse(event.text || event.output_text, event.response_id || activeOpenAIResponseIdRef.current);
        break;
      case 'response.output_item.done':
        if (event.item?.type === 'function_call') {
          void handleOpenAIFunctionCall({
            ...event.item,
            response_id: event.response_id || activeOpenAIResponseIdRef.current,
          }, transport);
        }
        break;
      case 'response.function_call_arguments.done':
        void handleOpenAIFunctionCall({
          name: event.name,
          arguments: event.arguments,
          call_id: event.call_id,
          response_id: event.response_id || activeOpenAIResponseIdRef.current,
        }, transport);
        break;
      case 'response.done':
        openAIResponseInFlightRef.current = false;
        // Function calls are handled on function_call_arguments.done / output_item.done.
        // Do not re-dispatch them here or we can stack response.create calls.
        finalizeOpenAITextResponse(
          event.response?.output
            ?.flatMap((item: any) => Array.isArray(item.content) ? item.content : [])
            ?.map((content: any) => content?.text || '')
            ?.join(' '),
          event.response?.id || event.response_id || activeOpenAIResponseIdRef.current,
        );
        setIsProcessing(false);
        if (openAIPendingResponseCreateRef.current && openAIActiveTransportRef.current) {
          openAIPendingResponseCreateRef.current = false;
          openAIResponseInFlightRef.current = true;
          openAIActiveTransportRef.current.send(JSON.stringify({ type: 'response.create' }));
        }
        break;
      case 'error':
        console.error('[OpenAI Realtime] Error:', event.error);
        openAIResponseInFlightRef.current = false;
        if (event.error?.code === 'conversation_already_has_active_response') {
          openAIPendingResponseCreateRef.current = true;
          break;
        }
        dispatchDashboardRealtimeResponse(
          event.error?.message || 'Sorry, I ran into an error while handling that request.',
          activeOpenAIPromptMetaRef.current,
          event.error?.message || 'realtime_error',
        );
        activeOpenAIPromptMetaRef.current = null;
        lastOpenAIFunctionResultRef.current = '';
        setIsProcessing(false);
        break;
    }
  };

  const requestOpenAIResponseCreate = (transport: OpenAIMessageTransport) => {
    openAIActiveTransportRef.current = transport;
    if (openAIResponseInFlightRef.current) {
      openAIPendingResponseCreateRef.current = true;
      return;
    }
    openAIResponseInFlightRef.current = true;
    transport.send(JSON.stringify({ type: 'response.create' }));
  };

  const handleOpenAIFunctionCall = async (functionCall: any, transport: OpenAIMessageTransport) => {
    const { name, arguments: argsString, call_id } = functionCall;
    const responseId = functionCall.response_id || activeOpenAIResponseIdRef.current;
    const dedupeKey = call_id
      ? `${responseId || 'response'}:${call_id}`
      : null;
    try {
      if (dedupeKey && processedOpenAIFunctionCallIdsRef.current.has(dedupeKey)) {
        return;
      }

      if (dedupeKey) {
        processedOpenAIFunctionCallIdsRef.current.add(dedupeKey);
      }

      const args = JSON.parse(argsString || '{}');
      let result: unknown = '';
      switch (name) {
        case 'navigate_to_page':
          result = navigateToPage(args.page);
          break;
        case 'highlight_element':
          result = highlightUIElement(args.element_id);
          break;
        case 'click_element':
          result = clickUIElement(args.element_id);
          break;
        case 'execute_site_action':
          result = compactAssistantActionResultForModel(
            await voiceCommands.executeActionAndWait(args.actionId, {
              ...(args.parameters || {}),
              requestSummary: args.parameters?.requestSummary || args.summary || `Execute ${args.actionId}`,
              customInstructions: args.parameters?.customInstructions || args.customInstructions,
              autoGenerate: args.parameters?.autoGenerate !== false,
            }),
          );
          break;
        case 'lookup_platform_data':
          result = await requestAssistantDataLookup(args);
          break;
        case 'compute_portfolio_metric': {
          const metricResult = await requestAssistantComputedAnalytics({
            metric: args.metric,
            propertyId: args.propertyId,
            year: args.year || args.taxYear,
          });
          const padResult = buildPortfolioMetricPadResult(metricResult);
          const propertyAddress = padResult.propertyAddress || args.propertyId || '';
          openAnalyticsResultInTaskPad({
            actionId: 'compute-portfolio-metric',
            title: 'Portfolio Metric',
            summary: String(padResult.speakableAnswer || padResult.summary),
            result: padResult,
            actions: propertyAddress
              ? [
                  {
                    id: 'open-property-analytics',
                    label: 'Open property analytics',
                    kind: 'navigate',
                    route: `/portfolio?tab=properties&address=${encodeURIComponent(String(propertyAddress))}&workspace=analytics`,
                    primary: true,
                  },
                  {
                    id: 'analyze-refinance',
                    label: 'Cash-out refinance check',
                    kind: 'refresh',
                    payload: {
                      actionId: 'analyze-property',
                      propertyAddress,
                      analysisType: 'refinance',
                      requestSummary: `Cash-out refinance analysis for ${propertyAddress}`,
                    },
                  },
                ]
              : [
                  {
                    id: 'open-portfolio',
                    label: 'Open Properties',
                    kind: 'navigate',
                    route: '/portfolio?tab=properties',
                    primary: true,
                  },
                ],
          });
          if (propertyAddress) {
            navigate(`/portfolio?tab=properties&address=${encodeURIComponent(String(propertyAddress))}&workspace=analytics`);
          }
          result = metricResult;
          break;
        }
        case 'google_search':
          result = await requestAssistantGoogleSearch({
            query: args.query,
            limit: args.limit,
          });
          break;
        case 'control_dashboard':
          window.dispatchEvent(new CustomEvent('houseyield:dashboard-control', {
            detail: args,
          }));
          result = args.answer || args.message || 'Dashboard updated.';
          lastOpenAIFunctionResultRef.current = typeof result === 'string' ? result : JSON.stringify(result);
          break;
        default:
          result = `Unknown function: ${name}`;
      }
      transport.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id,
          output: JSON.stringify({ success: true, result })
        }
      }));
      requestOpenAIResponseCreate(transport);
    } catch (err) {
      console.error('[OpenAI Realtime] Function call error:', err);

      transport.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id,
          output: JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : 'function_call_failed',
          })
        }
      }));
      requestOpenAIResponseCreate(transport);
    }
  };

  const handleVoiceEnrollment = useCallback(async () => {
    if (isConnected || voiceIdentityBusyAction) {
      return;
    }

    if (!user?.id) {
      setVoiceIdentityMessage('Voice identity requires a signed-in Firebase session.');
      return;
    }

    try {
      setVoiceIdentityBusyAction('enroll');
      setVoiceIdentityMessage('Recording a voice enrollment sample...');
      const audioBase64 = await captureMonoWavBase64({ durationMs: VOICE_IDENTITY_CAPTURE_DURATION_MS });
      const response = await enrollVoiceIdentitySample(audioBase64);

      if (!response.ok) {
        throw new Error(response.message || 'Voice enrollment failed.');
      }

      setVoiceIdentityMessage(`Voice sample saved (${response.sampleCount}/${response.recommendedSamples}). Add a few samples for the most accurate matching.`);
      await refreshVoiceIdentityStatus();
    } catch (error: any) {
      setVoiceIdentityMessage(error?.message || 'Voice enrollment failed.');
    } finally {
      setVoiceIdentityBusyAction(null);
    }
  }, [isConnected, refreshVoiceIdentityStatus, user?.id, voiceIdentityBusyAction]);

  const handleVoiceVerification = useCallback(async () => {
    if (isConnected || voiceIdentityBusyAction) {
      return;
    }

    if (!user?.id) {
      setVoiceIdentityMessage('Voice identity requires a signed-in Firebase session.');
      return;
    }

    try {
      setVoiceIdentityBusyAction('verify');
      setVoiceIdentityMessage('Recording a verification sample...');
      const audioBase64 = await captureMonoWavBase64({ durationMs: VOICE_IDENTITY_CAPTURE_DURATION_MS });
      const response = await verifyVoiceIdentitySample(audioBase64);

      if (!response.ok) {
        throw new Error(response.message || 'Voice verification failed.');
      }

      if (!response.matched || !response.unlockExpiresAt) {
        lockFinancialVoiceMode(`Voice verification did not match. Score ${Number(response.score || 0).toFixed(2)} vs threshold ${Number(response.threshold || 0).toFixed(2)}.`);
        return;
      }

      applyVoiceFinancialUnlock(response);
      await refreshVoiceIdentityStatus();
    } catch (error: any) {
      setVoiceIdentityMessage(error?.message || 'Voice verification failed.');
    } finally {
      setVoiceIdentityBusyAction(null);
    }
  }, [applyVoiceFinancialUnlock, isConnected, lockFinancialVoiceMode, refreshVoiceIdentityStatus, user?.id, voiceIdentityBusyAction]);

  const handleVoiceEnrollmentReset = useCallback(async () => {
    if (voiceIdentityBusyAction || !user?.id) {
      return;
    }

    try {
      setVoiceIdentityBusyAction('reset');
      const response = await resetVoiceIdentityEnrollment();
      if (!response.ok) {
        throw new Error(response.message || 'Voice enrollment reset failed.');
      }

      lockFinancialVoiceMode('Voice enrollment cleared. Add fresh samples so the app can recognize you automatically again.');
      await refreshVoiceIdentityStatus();
    } catch (error: any) {
      setVoiceIdentityMessage(error?.message || 'Voice enrollment reset failed.');
    } finally {
      setVoiceIdentityBusyAction(null);
    }
  }, [lockFinancialVoiceMode, refreshVoiceIdentityStatus, user?.id, voiceIdentityBusyAction]);

  const persistAssistantMemoryCleanupRef = useRef(persistAssistantMemory);
  const disconnectOpenAIRealtimeCleanupRef = useRef(disconnectOpenAIRealtime);
  const disconnectOpenAITextRealtimeCleanupRef = useRef(disconnectOpenAITextRealtime);

  useEffect(() => {
    persistAssistantMemoryCleanupRef.current = persistAssistantMemory;
    disconnectOpenAIRealtimeCleanupRef.current = disconnectOpenAIRealtime;
    disconnectOpenAITextRealtimeCleanupRef.current = disconnectOpenAITextRealtime;
  });

  useEffect(() => {
    // Only push session updates when meaningful context changes — never on every render.
    if (openaiDcRef.current?.readyState === 'open') {
      scheduleOpenAISessionUpdate({
        kind: 'audio',
        send: (data) => openaiDcRef.current?.send(data),
      });
    }

    if (openaiTextWsRef.current?.readyState === WebSocket.OPEN) {
      scheduleOpenAISessionUpdate({
        kind: 'text',
        send: (data) => openaiTextWsRef.current?.send(data),
      });
    }
  }, [userData, voiceFinancialAccessUnlocked, voiceFinancialUnlockLabel]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      void persistAssistantMemoryCleanupRef.current('unmount');
      resetAssistantMemoryTracking();
      disconnectOpenAIRealtimeCleanupRef.current();
      disconnectOpenAITextRealtimeCleanupRef.current();
    };
  }, [resetAssistantMemoryTracking]);

  // ===================================================================
  // TOGGLE / STOP / CLEAR
  // ===================================================================
  const toggleListening = async () => {
    if (isOpenAIConnected) {
      disconnectOpenAIRealtime();
    } else {
      await connectOpenAIRealtime();
    }
  };

  useEffect(() => {
    const handleToggleEvent = (event: Event) => {
      const customEvent = event as CustomEvent<VoiceAssistantToggleDetail>;
      const detail = customEvent.detail || {};
      const action = detail.action || 'toggle';

      const run = async () => {
        if (action === 'connect') {
          if (!isOpenAIConnected) {
            await connectOpenAIRealtime();
          }
          return;
        }

        if (action === 'disconnect') {
          if (isOpenAIConnected) {
            disconnectOpenAIRealtime();
          }
          disconnectOpenAITextRealtime();
          return;
        }

        await toggleListening();
      };

      void run();
    };

    const handlePromptEvent = (event: Event) => {
      const customEvent = event as CustomEvent<VoiceAssistantPromptDetail>;
      const prompt = customEvent.detail?.prompt || '';
      const requestedModalities = customEvent.detail?.modalities?.length
        ? customEvent.detail.modalities as RealtimeResponseModality[]
        : ['text' as RealtimeResponseModality];

      void queueOpenAITextPrompt(prompt, requestedModalities, {
        source: customEvent.detail?.source,
        requestId: customEvent.detail?.requestId,
      });
    };

    const handleDashboardContextEvent = (event: Event) => {
      const customEvent = event as CustomEvent<DashboardRealtimeContextDetail>;
      const detail = customEvent.detail || {};

      dashboardContextRef.current = detail.enabled === false ? null : detail;

      if (openaiDcRef.current?.readyState === 'open') {
        scheduleOpenAISessionUpdate({
          kind: 'audio',
          send: (data) => openaiDcRef.current?.send(data),
        }, { delayMs: 700 });
      }
      if (openaiTextWsRef.current?.readyState === WebSocket.OPEN) {
        scheduleOpenAISessionUpdate({
          kind: 'text',
          send: (data) => openaiTextWsRef.current?.send(data),
        }, { delayMs: 700 });
      }
    };

    window.addEventListener('houseyield:voice-assistant-toggle', handleToggleEvent as EventListener);
    window.addEventListener('houseyield:voice-assistant-prompt', handlePromptEvent as EventListener);
    window.addEventListener('houseyield:dashboard-context', handleDashboardContextEvent as EventListener);

    return () => {
      window.removeEventListener('houseyield:voice-assistant-toggle', handleToggleEvent as EventListener);
      window.removeEventListener('houseyield:voice-assistant-prompt', handlePromptEvent as EventListener);
      window.removeEventListener('houseyield:dashboard-context', handleDashboardContextEvent as EventListener);
    };
  }, [
    connectOpenAIRealtime,
    isOpenAIConnected,
    queueOpenAITextPrompt,
    sendOpenAISessionUpdate,
    toggleListening,
  ]);

  const stopSpeaking = () => {
    if (isOpenAIConnected) {
      disconnectOpenAIRealtime();
      return;
    }
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    window.speechSynthesis.cancel();
    isSpeakingRef.current = false;
    setIsSpeaking(false);
    setTranscript('');
  };

  const statusLabel = isConnectingRealtime
    ? 'Connecting…'
    : isProcessing
      ? 'Working…'
      : isSpeaking
        ? 'Speaking'
        : isConnected
          ? 'Listening — tap to stop'
          : 'Tap to talk';

  // Keep a lightweight upcoming-task badge on the support card.
  useEffect(() => {
    const onExperienceChanged = () => {
      setAssistantExperienceState(getAssistantExperience());
    };
    window.addEventListener('houseyield:assistant-experience-changed', onExperienceChanged);
    return () => window.removeEventListener('houseyield:assistant-experience-changed', onExperienceChanged);
  }, []);

  useEffect(() => {
    if (!user?.id) {
      setUpcomingTaskCount(0);
      return;
    }

    let cancelled = false;
    const refreshCount = async () => {
      try {
        const tasks = await listAssistantScheduledTasks({ includeCompleted: false, limit: 40 });
        if (!cancelled) {
          setUpcomingTaskCount(tasks.filter((task) => (
            task.status === 'scheduled' || task.status === 'paused' || task.status === 'running'
          )).length);
        }
      } catch {
        if (!cancelled) setUpcomingTaskCount(0);
      }
    };

    void refreshCount();
    const interval = window.setInterval(() => {
      void refreshCount();
    }, 60_000);

    const onFocus = () => {
      void refreshCount();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [user?.id, showScheduledTasksModal, showActivityCenter]);

  const askAssistantToSchedule = useCallback((prompt: string) => {
    void queueOpenAITextPrompt(prompt, ['text']);
  }, [queueOpenAITextPrompt]);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#1a4f8c] via-[#1d5fa3] to-[#0f766e] p-3 shadow-lg shadow-blue-950/25">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(255,255,255,0.18),transparent_55%)]" />

      <div className="relative mb-1 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            if (assistantExperience === 'intuitive') {
              setShowActivityCenter(true);
              return;
            }
            setShowScheduledTasksModal(true);
          }}
          className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/90 hover:bg-white/25"
          title={assistantExperience === 'intuitive' ? 'Open assistant activity' : 'Open scheduled tasks'}
        >
          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3M5 11h14M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          {assistantExperience === 'intuitive' ? 'Activity' : 'Schedule'}
          {upcomingTaskCount > 0 ? (
            <span className="rounded-full bg-white/25 px-1.5 py-0.5 text-[9px] font-bold normal-case tracking-normal">
              {upcomingTaskCount}
            </span>
          ) : null}
        </button>
        {(isConnected || isSpeaking) ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              stopSpeaking();
            }}
            className="rounded-full bg-white/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-white/90 hover:bg-white/25"
          >
            Stop
          </button>
        ) : null}
      </div>

      <button
        type="button"
        onClick={toggleListening}
        onPointerDown={() => {
          if (!isOpenAIConnected && !isProcessing) {
            void connectOpenAIRealtime().catch(() => {
              // connectOpenAIRealtime already surfaces the user-facing error.
            });
          }
        }}
        disabled={isProcessing && !isConnected}
        data-voice-id="sidebar-openai-realtime-trigger"
        aria-label={isOpenAIConnected ? 'Stop voice assistant' : 'Start voice assistant'}
        className="group relative flex w-full flex-col items-center rounded-xl px-2 py-5 text-center outline-none transition hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-70"
      >
        <span className="relative flex h-[4.5rem] w-[4.5rem] items-center justify-center">
          {(isConnected || isListening || isSpeaking || isProcessing || isConnectingRealtime) ? (
            <span
              className={`absolute inset-0 rounded-full motion-reduce:animate-none ${
                isSpeaking
                  ? 'animate-ping bg-emerald-300/25'
                  : 'animate-ping bg-sky-200/20'
              }`}
              style={{ animationDuration: '1.8s' }}
            />
          ) : (
            <span className="absolute inset-0 rounded-full bg-white/10 transition group-hover:bg-white/15" />
          )}
          <span
            className={`relative flex h-14 w-14 items-center justify-center rounded-full border border-white/25 transition duration-300 motion-reduce:transition-none ${
              isConnected || isListening
                ? 'bg-white/30 shadow-[0_0_0_6px_rgba(255,255,255,0.08)]'
                : isSpeaking
                  ? 'bg-emerald-300/30 shadow-[0_0_0_6px_rgba(110,231,183,0.12)]'
                  : isProcessing || isConnectingRealtime
                    ? 'bg-white/25'
                    : 'bg-white/20 group-hover:bg-white/28 group-hover:scale-[1.03]'
            }`}
          >
            <svg className="h-7 w-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isConnected || isListening ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z M10 10v4m4-4v4" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              )}
            </svg>
          </span>
        </span>

        <span className="mt-3 text-[13px] font-semibold tracking-wide text-white" role="status" aria-live="polite">
          {statusLabel}
        </span>
      </button>

      {(transcript || openaiTranscript) && (isListening || isConnected) ? (
        <div className="relative mt-0.5 rounded-lg bg-black/15 px-2.5 py-1.5">
          <p className="line-clamp-2 text-center text-[11px] italic text-white/85">
            “{transcript || openaiTranscript}”
          </p>
        </div>
      ) : null}

      {assistantExperience === 'legacy' ? (
        <AssistantScheduledTasksModal
          open={showScheduledTasksModal}
          onClose={() => setShowScheduledTasksModal(false)}
          onAskAssistant={askAssistantToSchedule}
        />
      ) : null}
      {assistantExperience === 'intuitive' ? (
        <AssistantActivityCenter
          open={showActivityCenter}
          onClose={() => setShowActivityCenter(false)}
          onAskAssistant={askAssistantToSchedule}
        />
      ) : null}
    </div>
  );
};

export default VoiceAISupportLiveKit;
