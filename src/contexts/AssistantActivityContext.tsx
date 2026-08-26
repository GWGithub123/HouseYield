import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import type {
  AssistantActionArtifact,
  AssistantActionResultPayload,
  AssistantPadAction,
  AssistantReuseMeta,
} from '../services/assistantActionResultTypes';
import type { WebsiteActionProgressEvent } from '../services/websiteControlService';
import { useAuth } from './AuthContext';
import {
  listAssistantActivities,
  type PersistedAssistantActivity,
} from '../services/assistantActivityClient';
import { trackAssistantTelemetry } from '../services/assistantTelemetry';
import { notifyAssistantEvent } from '../services/assistantNotificationPreferences';
import { getAssistantExperience } from '../services/assistantExperienceFlags';

export type AssistantActivityStatus = 'running' | 'complete' | 'error';

export interface AssistantActivityRun {
  runId: string;
  actionId: string;
  sequence: number;
  title: string;
  summary: string;
  highlights: string[];
  steps: string[];
  currentStep: number;
  status: AssistantActivityStatus;
  detailMessage?: string;
  error?: string;
  result?: AssistantActionResultPayload;
  actions?: AssistantPadAction[];
  artifacts?: AssistantActionArtifact[];
  reuseMeta?: AssistantReuseMeta;
  startedAt: number;
  completedAt?: number;
  dismissed?: boolean;
}

export interface AssistantActivityEvent {
  runId: string;
  sequence: number;
  occurredAt: number;
  actionId: string;
  title: string;
  summary: string;
  highlights?: string[];
  steps: string[];
  currentStep: number;
  status: AssistantActivityStatus;
  detailMessage?: string;
  error?: string;
  result?: AssistantActionResultPayload;
  actions?: AssistantPadAction[];
  artifacts?: AssistantActionArtifact[];
  reuseMeta?: AssistantReuseMeta;
}

interface AssistantActivityState {
  runs: AssistantActivityRun[];
  activeRunId: string | null;
}

type AssistantActivityAction =
  | { type: 'event'; event: AssistantActivityEvent }
  | { type: 'dismiss'; runId: string }
  | { type: 'activate'; runId: string }
  | { type: 'clear-completed' }
  | { type: 'hydrate'; runs: AssistantActivityRun[] };

const STORAGE_KEY = 'houseyield:assistant-activity:v1';
const MAX_PERSISTED_RUNS = 50;
const MAX_LOCAL_STORAGE_RUNS = 12;

function slimRunForStorage(run: AssistantActivityRun): AssistantActivityRun {
  const result = run.result
    ? {
        ...run.result,
        // Keep typed metadata, drop bulky draft/document bodies from localStorage.
        ...(run.result.type === 'document'
          ? { content: undefined, previewText: run.result.previewText?.slice(0, 280) }
          : {}),
        ...(run.result.type === 'message_draft'
          ? { body: run.result.body.slice(0, 280) }
          : {}),
      }
    : undefined;

  return {
    ...run,
    summary: run.summary.slice(0, 400),
    highlights: run.highlights.slice(0, 5).map((item) => item.slice(0, 160)),
    detailMessage: run.detailMessage?.slice(0, 280),
    error: run.error?.slice(0, 280),
    result: result as AssistantActivityRun['result'],
  };
}

function writeStoredRuns(runs: AssistantActivityRun[]) {
  const candidates = [
    runs.slice(-MAX_LOCAL_STORAGE_RUNS).map(slimRunForStorage),
    runs.slice(-6).map(slimRunForStorage).map((run) => ({
      ...run,
      result: undefined,
      actions: undefined,
      artifacts: undefined,
    })),
  ];

  for (const payload of candidates) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return;
    } catch {
      // Try a smaller payload next.
    }
  }

  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore if storage is unavailable.
  }
}

function assistantActivityReducer(
  state: AssistantActivityState,
  action: AssistantActivityAction,
): AssistantActivityState {
  if (action.type === 'hydrate') {
    return { ...state, runs: action.runs.slice(-MAX_PERSISTED_RUNS) };
  }
  if (action.type === 'dismiss') {
    return {
      ...state,
      activeRunId: state.activeRunId === action.runId ? null : state.activeRunId,
      runs: state.runs.map((run) => run.runId === action.runId ? { ...run, dismissed: true } : run),
    };
  }
  if (action.type === 'activate') {
    return {
      ...state,
      activeRunId: action.runId,
      runs: state.runs.map((run) => run.runId === action.runId ? { ...run, dismissed: false } : run),
    };
  }
  if (action.type === 'clear-completed') {
    return {
      ...state,
      runs: state.runs.filter((run) => run.status === 'running'),
    };
  }

  const event = action.event;
  const existing = state.runs.find((run) => run.runId === event.runId);
  if (existing && event.sequence <= existing.sequence) {
    return state;
  }

  const run: AssistantActivityRun = {
    ...existing,
    ...event,
    highlights: event.highlights ?? existing?.highlights ?? [],
    startedAt: existing?.startedAt ?? event.occurredAt,
    completedAt: event.status === 'running' ? undefined : event.occurredAt,
    dismissed: false,
  };
  const runs = existing
    ? state.runs.map((candidate) => candidate.runId === event.runId ? run : candidate)
    : [...state.runs, run];

  return {
    runs: runs.slice(-MAX_PERSISTED_RUNS),
    activeRunId: event.runId,
  };
}

interface AssistantActivityContextValue {
  runs: AssistantActivityRun[];
  activeRun: AssistantActivityRun | null;
  dispatchActivity: (event: AssistantActivityEvent) => void;
  dismissRun: (runId: string) => void;
  activateRun: (runId: string) => void;
  clearCompleted: () => void;
  refreshActivities: () => Promise<void>;
}

const AssistantActivityContext = createContext<AssistantActivityContextValue | null>(null);

function readStoredRuns(): AssistantActivityRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    // Guard against previously unbounded activity payloads that filled the origin quota.
    if (raw.length > 750_000) {
      localStorage.removeItem(STORAGE_KEY);
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(-MAX_LOCAL_STORAGE_RUNS) : [];
  } catch {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    return [];
  }
}

function mapPersistedActivity(activity: PersistedAssistantActivity): AssistantActivityRun {
  const status: AssistantActivityStatus = activity.status === 'completed'
    ? 'complete'
    : activity.status === 'failed' || activity.status === 'cancelled'
      ? 'error'
      : 'running';
  return {
    runId: activity.runId,
    actionId: activity.actionId,
    sequence: Number(activity.sequence) || 1,
    title: activity.actionId.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
    summary: activity.requestSummary || 'Assistant activity',
    highlights: [],
    steps: [activity.status === 'needs_input' ? 'Waiting for your input' : 'Working on your request'],
    currentStep: 0,
    status,
    error: activity.error || undefined,
    result: activity.result as AssistantActionResultPayload | undefined,
    actions: activity.actions as AssistantPadAction[] | undefined,
    artifacts: activity.artifacts as AssistantActionArtifact[] | undefined,
    startedAt: Date.parse(activity.startedAt || activity.createdAt || activity.updatedAt || '') || Date.now(),
    completedAt: activity.completedAt ? Date.parse(activity.completedAt) || undefined : undefined,
    dismissed: true,
  };
}

export function AssistantActivityProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [state, dispatch] = useReducer(assistantActivityReducer, {
    runs: [],
    activeRunId: null,
  });
  const legacyRunsRef = useRef(new Map<string, { runId: string; sequence: number; terminal: boolean }>());
  const runsRef = useRef(state.runs);
  runsRef.current = state.runs;

  useEffect(() => {
    dispatch({ type: 'hydrate', runs: readStoredRuns() });
  }, []);

  useEffect(() => {
    writeStoredRuns(state.runs);
  }, [state.runs]);

  const refreshActivities = useCallback(async () => {
    if (!user?.id) return;
    const persisted = await listAssistantActivities(MAX_PERSISTED_RUNS);
    const merged = new Map(readStoredRuns().map((run) => [run.runId, run]));
    persisted.map(mapPersistedActivity).forEach((run) => {
      const existing = merged.get(run.runId);
      merged.set(run.runId, existing && existing.sequence >= run.sequence ? existing : run);
    });
    dispatch({
      type: 'hydrate',
      runs: Array.from(merged.values()).sort((left, right) => left.startedAt - right.startedAt),
    });
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    void refreshActivities().catch(() => {
      // The local activity ledger remains usable while offline.
    });
  }, [refreshActivities, user?.id]);

  useEffect(() => {
    const handleActivityEvent = (event: Event) => {
      const detail = (event as CustomEvent<AssistantActivityEvent>).detail;
      if (detail?.runId && Number.isFinite(detail.sequence)) {
        dispatch({ type: 'event', event: detail });
      }
    };
    const handleLegacyProgress = (event: Event) => {
      const detail = (event as CustomEvent<WebsiteActionProgressEvent & {
        runId?: string;
        sequence?: number;
      }>).detail;
      if (!detail?.actionId) return;

      const legacyKey = detail.runId || detail.actionId;
      const previous = legacyRunsRef.current.get(legacyKey);
      const startsNewRun = detail.status === 'start' || !previous || previous.terminal;
      const runId = detail.runId || (startsNewRun
        ? `${detail.actionId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
        : previous.runId);
      const sequence = detail.sequence ?? (startsNewRun ? 1 : previous.sequence + 1);
      const status: AssistantActivityStatus = detail.status === 'complete'
        ? 'complete'
        : detail.status === 'error'
          ? 'error'
          : 'running';

      legacyRunsRef.current.set(legacyKey, {
        runId,
        sequence,
        terminal: status !== 'running',
      });
      dispatch({
        type: 'event',
        event: {
          runId,
          sequence,
          occurredAt: Date.now(),
          actionId: detail.actionId,
          title: detail.title,
          summary: detail.summary,
          highlights: detail.result && 'bullets' in detail.result ? detail.result.bullets?.slice(0, 3) : undefined,
          steps: detail.steps,
          currentStep: detail.currentStep,
          status,
          error: detail.error,
          detailMessage: detail.detailMessage,
          result: detail.result,
          actions: detail.actions,
          artifacts: detail.artifacts,
          reuseMeta: detail.reuseMeta,
        },
      });
      if (startsNewRun) {
        trackAssistantTelemetry('activity_started', { runId, actionId: detail.actionId, surface: 'work_panel' });
      } else if (status === 'complete') {
        trackAssistantTelemetry('activity_completed', {
          runId,
          actionId: detail.actionId,
          durationMs: Date.now() - (runsRef.current.find((run) => run.runId === runId)?.startedAt || Date.now()),
          surface: 'work_panel',
        });
        if (getAssistantExperience() === 'intuitive') {
          void notifyAssistantEvent('completion', {
            title: detail.title || 'Assistant finished',
            body: detail.summary || 'Your request is ready to review.',
            actionId: detail.actionId,
          });
        }
      } else if (status === 'error') {
        trackAssistantTelemetry('activity_failed', { runId, actionId: detail.actionId, surface: 'work_panel' });
        if (getAssistantExperience() === 'intuitive') {
          void notifyAssistantEvent('failure', {
            title: detail.title || 'Assistant needs attention',
            body: detail.error || detail.summary || 'Something went wrong.',
            actionId: detail.actionId,
          });
        }
      } else if (detail.result?.type === 'needs_input') {
        trackAssistantTelemetry('activity_waiting_for_input', {
          runId,
          actionId: detail.actionId,
          surface: 'work_panel',
        });
        if (getAssistantExperience() === 'intuitive') {
          void notifyAssistantEvent('approval', {
            title: detail.title || 'Review needed',
            body: detail.summary || 'The assistant is waiting for your approval.',
            actionId: detail.actionId,
          });
        }
      }
    };

    window.addEventListener('houseyield:assistant-activity', handleActivityEvent);
    window.addEventListener('houseyield:action-progress', handleLegacyProgress);
    return () => {
      window.removeEventListener('houseyield:assistant-activity', handleActivityEvent);
      window.removeEventListener('houseyield:action-progress', handleLegacyProgress);
    };
  }, []);

  const dispatchActivity = useCallback((event: AssistantActivityEvent) => {
    const current = runsRef.current.find((run) => run.runId === event.runId);
    if (current && event.sequence <= current.sequence) {
      trackAssistantTelemetry('duplicate_event_ignored', {
        runId: event.runId,
        actionId: event.actionId,
        sequence: event.sequence,
      });
    }
    dispatch({ type: 'event', event });
  }, []);
  const dismissRun = useCallback((runId: string) => dispatch({ type: 'dismiss', runId }), []);
  const activateRun = useCallback((runId: string) => dispatch({ type: 'activate', runId }), []);
  const clearCompleted = useCallback(() => dispatch({ type: 'clear-completed' }), []);
  const activeRun = state.runs.find((run) => run.runId === state.activeRunId && !run.dismissed) ?? null;

  const value = useMemo(() => ({
    runs: state.runs,
    activeRun,
    dispatchActivity,
    dismissRun,
    activateRun,
    clearCompleted,
    refreshActivities,
  }), [activateRun, activeRun, clearCompleted, dismissRun, dispatchActivity, refreshActivities, state.runs]);

  return <AssistantActivityContext.Provider value={value}>{children}</AssistantActivityContext.Provider>;
}

export function useAssistantActivity() {
  const context = useContext(AssistantActivityContext);
  if (!context) {
    throw new Error('useAssistantActivity must be used within AssistantActivityProvider');
  }
  return context;
}

export { assistantActivityReducer };
