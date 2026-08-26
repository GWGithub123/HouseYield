import {
  ensureNotificationPermission,
  registerServiceWorker,
  subscribeToPush,
} from './pushNotifications';

export type AssistantNotificationCategory =
  | 'completion'
  | 'failure'
  | 'approval'
  | 'reminder';

export type AssistantNotificationPreferences = Record<AssistantNotificationCategory, boolean>;

const STORAGE_KEY = 'houseyield:assistant-notification-prefs:v1';

const DEFAULT_PREFERENCES: AssistantNotificationPreferences = {
  completion: true,
  failure: true,
  approval: true,
  reminder: true,
};

const TRIVIAL_NAVIGATION_PATTERN = /\b(navigate|go[-_]?to|open[-_]?page|show[-_]?page|scroll|highlight)\b/i;

function readPreferences(): AssistantNotificationPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<AssistantNotificationPreferences>;
    return {
      completion: parsed.completion !== false,
      failure: parsed.failure !== false,
      approval: parsed.approval !== false,
      reminder: parsed.reminder !== false,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

function writePreferences(preferences: AssistantNotificationPreferences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    try {
      localStorage.removeItem('houseyield:assistant-activity:v1');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Preference persistence is optional.
    }
  }
}

export function getAssistantNotificationPreferences(): AssistantNotificationPreferences {
  return readPreferences();
}

export function setAssistantNotificationPreference(
  category: AssistantNotificationCategory,
  enabled: boolean,
): AssistantNotificationPreferences {
  const next = {
    ...readPreferences(),
    [category]: enabled,
  };
  writePreferences(next);
  return next;
}

export function isTrivialAssistantNavigation(actionId?: string | null, title?: string | null) {
  const haystack = `${actionId || ''} ${title || ''}`.trim();
  if (!haystack) return false;
  return TRIVIAL_NAVIGATION_PATTERN.test(haystack);
}

export function shouldNotifyAssistantEvent(
  category: AssistantNotificationCategory,
  meta: { actionId?: string | null; title?: string | null } = {},
) {
  if (isTrivialAssistantNavigation(meta.actionId, meta.title)) {
    return false;
  }
  return readPreferences()[category] !== false;
}

export async function ensureAssistantPushReady() {
  const permission = await ensureNotificationPermission();
  if (permission !== 'granted') {
    return { ok: false as const, reason: 'Notifications permission not granted' };
  }
  await registerServiceWorker();
  return subscribeToPush();
}

export async function notifyAssistantEvent(
  category: AssistantNotificationCategory,
  options: {
    title: string;
    body: string;
    actionId?: string | null;
  },
): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
  if (!shouldNotifyAssistantEvent(category, options)) {
    return { ok: true, skipped: true };
  }

  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return { ok: false, reason: 'Notifications unavailable' };
  }

  try {
    const registration = await registerServiceWorker();
    const payload = {
      title: options.title.slice(0, 80),
      body: options.body.slice(0, 160),
      data: { category, actionId: options.actionId || undefined },
    };
    if (registration?.showNotification) {
      await registration.showNotification(payload.title, {
        body: payload.body,
        data: payload.data,
        tag: `assistant-${category}`,
      });
    } else {
      // Fallback for environments without an active service worker registration.
      // eslint-disable-next-line no-new
      new Notification(payload.title, { body: payload.body, data: payload.data });
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'Could not show notification',
    };
  }
}
