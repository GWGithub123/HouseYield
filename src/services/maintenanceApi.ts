/**
 * Client API for the maintenance orchestration surfaces.
 *
 * Wraps the conversational triage endpoint, photo uploads, and ticket submission so
 * the owner intake, tenant form, and ticket detail views share one contract.
 */

export type MaintenancePriority = 'low' | 'normal' | 'urgent';
export type MaintenanceEmergencyLevel = 'none' | 'urgent' | 'call_911';
export type AvailabilityWindow = 'morning' | 'afternoon' | 'evening';

export type AccessMethod =
  | 'unspecified'
  | 'owner_present'
  | 'tenant_present'
  | 'lockbox'
  | 'hidden_key'
  | 'smart_lock'
  | 'concierge';

export interface MaintenanceTriage {
  category: string;
  priority: MaintenancePriority;
  location: string;
  summary: string;
  ownerSummary?: string;
  serviceTypeHint?: string;
  readyToSubmit: boolean;
  emergencyLevel: MaintenanceEmergencyLevel;
  emergencyGuidance?: string;
  suggestedActions?: string[];
  liveAssistantSummary?: string;
  appliance?: {
    isVisible: boolean;
    type: string;
    brand: string;
    model: string;
    confidence: 'high' | 'medium' | 'low';
  } | null;
  applianceTroubleshooting?: {
    steps: string[];
    safetyWarnings?: string[];
    needsProfessional?: boolean;
  } | null;
  transcript?: Array<{ role: string; content: string }>;
}

export interface TriageChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at?: string | null;
  /**
   * Shown in the chat bubble instead of `content`. Tapped answers send the question
   * along with the choice so the transcript stays unambiguous, while the bubble
   * shows only what the person picked.
   */
  display?: string;
}

export interface TriageChoiceOption {
  id: string;
  label: string;
  detail?: string;
}

/** A follow-up the submitter answers by tapping, rather than typing. */
export interface TriageQuestion {
  id: string;
  question: string;
  allowMultiple?: boolean;
  options: TriageChoiceOption[];
}

export interface TriageResponse {
  ok: boolean;
  reply: string;
  questions: TriageQuestion[];
  triage: MaintenanceTriage;
  provider?: string;
  /** True when the AI call failed and rule-based intake answered instead. */
  degraded?: boolean;
  error?: string;
}

export interface MaintenancePhoto {
  url: string;
  name: string;
  contentType: string;
  size: number;
  kind: string;
  storagePath: string;
  inline: boolean;
  uploadedAt: string;
}

export interface PropertyAccess {
  method: AccessMethod;
  instructions: string;
  code: string;
  smartLockProvider: string;
  contactName: string;
  contactPhone: string;
}

export interface AvailabilitySelection {
  date: string;
  windows: AvailabilityWindow[];
}

export interface MaintenanceSubmitPayload {
  category: string;
  priority: MaintenancePriority;
  description: string;
  location?: string;
  propertyAddress?: string;
  unit?: string;
  ownerId?: string;
  propertyId?: string;
  tenantId?: string;
  tenantEmail?: string;
  tenantName?: string;
  triage?: MaintenanceTriage | null;
  photos?: MaintenancePhoto[];
  propertyAccess?: PropertyAccess;
  availabilityWindows?: AvailabilitySelection[];
  tenantAvailability?: string;
  submittedBy?: { role: 'owner' | 'tenant' | 'operator' | 'system'; userId?: string; name?: string; email?: string };
  intake?: { mode: 'ai_chat' | 'form'; transcript?: TriageChatMessage[]; extracted?: MaintenanceTriage | null; completedAt?: string | null };
  autoBook?: boolean;
  trustedProvider?: { name: string; phone: string; email?: string; notes?: string };
  practiceTestPhone?: string | null;
  sensorContext?: {
    alertId: string;
    alertType: string;
    severity: string;
    detectedAt: string;
    deviceId: string;
    deviceName: string;
    deviceModel?: string;
    room?: string;
    message: string;
    readings?: {
      temperatureC?: number;
      temperatureF?: number;
      humidityPercent?: number;
      floodDetected?: boolean;
      batteryPercent?: number;
      signalDbm?: number;
      deviceStatus?: string;
    };
  };
}

export const ACCESS_METHOD_LABELS: Record<AccessMethod, string> = {
  unspecified: 'Not specified',
  owner_present: "I'll be there to let them in",
  tenant_present: 'The tenant will be there',
  lockbox: 'Lockbox on site',
  hidden_key: 'Hidden key on site',
  smart_lock: 'Smart lock code',
  concierge: 'Building concierge or front desk',
};

export const AVAILABILITY_WINDOW_LABELS: Record<AvailabilityWindow, string> = {
  morning: 'Morning (8am–12pm)',
  afternoon: 'Afternoon (12pm–5pm)',
  evening: 'Evening (5pm–9pm)',
};

export function buildDefaultPropertyAccess(): PropertyAccess {
  return {
    method: 'unspecified',
    instructions: '',
    code: '',
    smartLockProvider: '',
    contactName: '',
    contactPhone: '',
  };
}

/** Availability shown to a dispatcher as one readable line. */
export function formatAvailabilitySelections(selections: AvailabilitySelection[]): string {
  if (!selections.length) return '';

  return [...selections]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, windows }) => {
      const label = formatAvailabilityDate(date);
      if (!windows.length) return label;
      return `${label}: ${windows.map((w) => AVAILABILITY_WINDOW_LABELS[w]).join(', ')}`;
    })
    .join(' | ');
}

export function formatAvailabilityDate(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  if (!year || !month || !day) return dateStr;
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Unexpected response from server (${response.status})`);
  }
  if (!response.ok) {
    throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
  }
  return data as T;
}

/**
 * Send one turn of the intake conversation. The server keeps no session, so the
 * full message history and the draft-so-far travel with each request.
 */
export async function sendTriageMessage({
  message,
  messages = [],
  currentDraft = null,
  submitterRole = 'tenant',
  answeredQuestionIds = [],
}: {
  message: string;
  messages?: TriageChatMessage[];
  currentDraft?: MaintenanceTriage | null;
  submitterRole?: 'owner' | 'tenant';
  /** Ids already answered this session, so the assistant does not repeat them. */
  answeredQuestionIds?: string[];
}): Promise<TriageResponse> {
  const response = await fetch('/api/maintenance/triage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      messages: messages.map(({ role, content }) => ({ role, content })),
      currentDraft,
      submitterRole,
      answeredQuestionIds,
    }),
  });

  const parsed = await parseJson<TriageResponse>(response);
  return { ...parsed, questions: Array.isArray(parsed.questions) ? parsed.questions : [] };
}

function readFileAsBase64(file: File): Promise<{ name: string; contentType: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      resolve({
        name: file.name,
        contentType: file.type || 'image/jpeg',
        data: String(reader.result || ''),
      });
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Upload photos and get back durable URLs. Safe to call before a ticket exists —
 * pass `requestId` only when attaching to an already-created ticket.
 */
export async function uploadMaintenancePhotos({
  files,
  ownerId,
  requestId,
  kind = 'issue',
}: {
  files: File[];
  ownerId?: string;
  requestId?: string;
  kind?: 'issue' | 'before' | 'after' | 'parts' | 'receipt';
}): Promise<{ photos: MaintenancePhoto[]; storage: string; errors: Array<{ index: number; error: string }> }> {
  if (!files.length) {
    return { photos: [], storage: 'none', errors: [] };
  }

  const encoded = await Promise.all(files.map(readFileAsBase64));

  const response = await fetch('/api/maintenance/photos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photos: encoded, ownerId, requestId, kind }),
  });

  const data = await parseJson<{
    photos: MaintenancePhoto[];
    storage: string;
    errors: Array<{ index: number; error: string }>;
  }>(response);

  return { photos: data.photos || [], storage: data.storage || 'none', errors: data.errors || [] };
}

export async function submitMaintenanceRequest(payload: MaintenanceSubmitPayload) {
  const response = await fetch('/api/maintenance/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return parseJson<{
    ok: boolean;
    request: { id: string; firestoreId?: string };
    message?: string;
    awaitingOwnerConfirmation?: boolean;
    aiAutomation?: Record<string, unknown>;
  }>(response);
}
