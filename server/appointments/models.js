// Appointment domain models (plain JS for now)
import crypto from 'crypto';

export const AppointmentStatus = {
  PENDING_PROVIDER_SELECTION: 'pending_provider_selection',
  PROVIDER_SELECTED: 'provider_selected',
  OUTBOUND_SENT: 'outbound_sent',
  PROVIDER_PENDING: 'provider_pending',
  CONFIRMED: 'confirmed',
  RESCHEDULE_REQUESTED: 'reschedule_requested',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
};

export function newAppointmentRequest({ address, issueDescription, providerId = null, preferredSlots = [], constraints = {} }) {
  const now = new Date().toISOString();
  return {
    id: 'apt_' + crypto.randomUUID(),
    address,
    issueDescription,
    extractedIssue: null,
    extractedCategory: null,
    providerId,
    preferredSlots, // array of ProposedSlot
    confirmedSlotId: null,
    constraints,
    channelSelected: null,
    status: providerId ? AppointmentStatus.PROVIDER_SELECTED : AppointmentStatus.PENDING_PROVIDER_SELECTION,
    attempts: [],
    createdAt: now,
    updatedAt: now,
    escalationLevel: 0,
    metadata: {}
  };
}

export function newProposedSlot({ start, end, score = 0, source = 'generated' }) {
  return {
    id: 'slot_' + crypto.randomUUID(),
    start, // ISO
    end,   // ISO
    score,
    source,
    status: 'proposed'
  };
}

export function newAttempt({ requestId, channel, providerId, payloadSnapshot }) {
  return {
    id: 'att_' + crypto.randomUUID(),
    requestId,
    channel,
    providerId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: 'pending',
    payloadSnapshot,
    responseRaw: null,
    parsedOutcome: null,
    errorMessage: null,
    retryCount: 0
  };
}

export function newEvent({ requestId, type, actor = 'system', data = {} }) {
  return {
    id: 'evt_' + crypto.randomUUID(),
    requestId,
    type,
    actor,
    data,
    at: new Date().toISOString()
  };
}
