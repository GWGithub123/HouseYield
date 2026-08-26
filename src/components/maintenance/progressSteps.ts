/**
 * Single source of truth for the six-dot maintenance progress state machine.
 *
 * The customer tracker and the internal ops console both derive their steps here so
 * an operator never sees a different stage than the owner they are on the phone with.
 */

import type { AiAutomation, MaintenanceTicket, ScheduledVisit } from './ticketTypes';

export type StepId = 'reported' | 'search' | 'connected' | 'scheduled' | 'performed' | 'paid';
export type StepState = 'complete' | 'active' | 'pending';

export interface ProgressStep {
  id: StepId;
  label: string;
  /** Short imperative label for the operator action rail. */
  opsLabel: string;
  state: StepState;
  timestamp?: string | null;
  dateLabel?: string;
}

export const STEP_ORDER: StepId[] = ['reported', 'search', 'connected', 'scheduled', 'performed', 'paid'];

const STEP_LABELS: Record<StepId, { label: string; opsLabel: string }> = {
  reported: { label: 'Issue reported', opsLabel: 'Intake' },
  search: { label: 'Provider search', opsLabel: 'Find providers' },
  connected: { label: 'Provider connected', opsLabel: 'Log the call' },
  scheduled: { label: 'Service scheduled', opsLabel: 'Book the visit' },
  performed: { label: 'Service performed', opsLabel: 'Record the work' },
  paid: { label: 'Provider paid', opsLabel: 'Close out' },
};

export function formatShortDate(dateStr?: string | null, timezone?: string) {
  if (!dateStr) return '';

  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

export function formatVisitWindow(visit: ScheduledVisit) {
  const timezone = visit.timezone || 'America/New_York';
  const start = new Date(visit.startAt);
  if (Number.isNaN(start.getTime())) return '';

  const startLabel = start.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  });

  const end = visit.endAt ? new Date(visit.endAt) : null;
  if (!end || Number.isNaN(end.getTime())) return startLabel;

  const endLabel = end.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  });

  return `${startLabel} – ${endLabel}`;
}

export function isSearchComplete(ai: AiAutomation) {
  return Boolean(
    ai.providerSearch
    || ai.selectedProvider
    || (ai.providerShortlist && ai.providerShortlist.length > 0)
    || ['processing', 'provider_found', 'awaiting_operator_dispatch', 'provider_contacted', 'scheduled_for_callback', 'scheduled', 'completed'].includes(ai.status),
  );
}

/**
 * "Connected" means a human actually reached the provider — either an operator logged
 * a call or the legacy automated call went out.
 */
export function isConnectedComplete(ai: AiAutomation) {
  if (ai.operatorCall?.calledAt) return true;
  return Boolean(ai.selectedProvider && (ai.callInitiated || ai.callDetails?.callSid || ai.callDetails?.initiatedAt));
}

export function buildProgressSteps(request: MaintenanceTicket): ProgressStep[] {
  const ai = request.aiAutomation || { status: '' };
  const awaitingOwner = ai.status === 'awaiting_owner_confirmation';

  const completions: Record<StepId, boolean> = {
    reported: true,
    search: !awaitingOwner && isSearchComplete(ai),
    connected: !awaitingOwner && isConnectedComplete(ai),
    scheduled: Boolean(request.scheduledVisit?.confirmed && request.scheduledVisit?.startAt),
    performed: Boolean(
      request.serviceRecord?.completedAt
      || request.serviceCompletion?.completedAt
      || request.status === 'completed',
    ),
    paid: Boolean(
      request.paymentWorkflow?.status === 'paid'
      || request.paymentWorkflow?.ownerChargeSucceededAt,
    ),
  };

  const firstIncomplete = STEP_ORDER.find((id) => !completions[id]);

  const performedAt = request.serviceRecord?.completedAt || request.serviceCompletion?.completedAt || null;
  const connectedAt = ai.operatorCall?.calledAt || ai.callDetails?.initiatedAt || null;

  const timestamps: Record<StepId, string | null> = {
    reported: request.createdAt || null,
    search: completions.search ? request.updatedAt || request.createdAt || null : null,
    connected: connectedAt,
    scheduled: request.scheduledVisit?.startAt || null,
    performed: performedAt,
    paid: request.paymentWorkflow?.ownerChargeSucceededAt || null,
  };

  return STEP_ORDER.map((id) => {
    const state: StepState = (awaitingOwner && id === 'search')
      ? 'active'
      : completions[id]
        ? 'complete'
        : firstIncomplete === id
          ? 'active'
          : 'pending';

    const dateLabel = id === 'scheduled' && request.scheduledVisit?.startAt
      ? formatVisitWindow(request.scheduledVisit)
      : formatShortDate(timestamps[id]);

    return {
      id,
      label: STEP_LABELS[id].label,
      opsLabel: STEP_LABELS[id].opsLabel,
      state,
      timestamp: timestamps[id],
      dateLabel,
    };
  });
}

/** The step an operator should act on next. */
export function nextActionableStep(steps: ProgressStep[]): StepId {
  return steps.find((step) => step.state === 'active')?.id
    || steps.filter((step) => step.state === 'complete').slice(-1)[0]?.id
    || 'reported';
}

/** Short human label for what the ticket is waiting on, used in the queue list. */
export function describeWaitingOn(request: MaintenanceTicket): string {
  const ai = request.aiAutomation || { status: '' };

  if (request.paymentWorkflow?.status === 'paid') return 'Closed';
  if (request.serviceRecord?.completedAt || request.serviceCompletion?.completedAt) return 'Awaiting payment';
  if (request.scheduledVisit?.confirmed) return 'Visit scheduled';
  if (ai.status === 'awaiting_owner_confirmation') return 'Awaiting owner OK';
  if (ai.operatorCall?.outcome === 'callback') return 'Provider callback';
  if (ai.operatorCall?.calledAt) return 'Needs a booked time';
  if (ai.status === 'awaiting_operator_dispatch') return 'Needs a call';
  if (isSearchComplete(ai)) return 'Needs a call';
  return 'Needs provider search';
}
