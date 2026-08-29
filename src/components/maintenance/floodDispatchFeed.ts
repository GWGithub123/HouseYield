/**
 * Compact vertical feed for the flood-sensor rail.
 *
 * Same ticket as Maintenance progress, but the early automation is spelled out
 * as live events a demo can watch without leaving the twin.
 */

import type { MaintenanceTicket } from './ticketTypes';
import {
  formatShortDate,
  isConnectedComplete,
} from './progressSteps';

export type DispatchFeedState = 'complete' | 'active' | 'pending';

export interface DispatchFeedItem {
  id: string;
  label: string;
  detail?: string;
  state: DispatchFeedState;
  time?: string;
}

function firstActive(done: boolean[]): number {
  const index = done.findIndex((value) => !value);
  return index === -1 ? done.length : index;
}

function stateAt(index: number, done: boolean[], activeIndex: number): DispatchFeedState {
  if (done[index]) return 'complete';
  if (index === activeIndex) return 'active';
  return 'pending';
}

export function buildFloodDispatchFeed(request: MaintenanceTicket | null): DispatchFeedItem[] {
  if (!request) {
    return [
      { id: 'ticket', label: 'Opening maintenance ticket', state: 'active', detail: 'Flood alert just came in' },
      { id: 'search', label: 'Searching for a plumber', state: 'pending' },
      { id: 'identify', label: 'Identifying plumber', state: 'pending' },
      { id: 'sms', label: 'Texting the owner', state: 'pending' },
      { id: 'call', label: 'Placing a scheduling call', state: 'pending' },
    ];
  }

  const ai = request.aiAutomation || { status: '' };
  const sms = request.ownerSmsNotifications;
  const providerName = ai.selectedProvider?.name || request.scheduledVisit?.providerName || '';
  const searchDone = Boolean(
    ai.providerSearch
    || ai.selectedProvider
    || (ai.providerShortlist && ai.providerShortlist.length > 0)
    || [
      'provider_found',
      'awaiting_operator_dispatch',
      'awaiting_provider_approval',
      'provider_contacted',
      'scheduled_for_callback',
      'scheduled',
      'completed',
    ].includes(ai.status),
  );
  const identified = Boolean(providerName);
  const smsFailed = sms?.status === 'send_failed';
  const smsSent = Boolean(sms?.sentAt)
    || ['pending', 'confirmed', 'declined'].includes(String(sms?.status || ''));
  const callDone = isConnectedComplete(ai);
  const scheduled = Boolean(request.scheduledVisit?.confirmed && request.scheduledVisit?.startAt);
  const awaitingYes = ai.status === 'awaiting_owner_confirmation'
    || ai.status === 'awaiting_provider_approval'
    || sms?.status === 'pending';

  const done = [
    true,
    searchDone,
    identified,
    smsSent || smsFailed,
    callDone || scheduled,
  ];
  const activeIndex = firstActive(done);

  const found = ai.providerSearch?.totalFound;
  const searchDetail = found
    ? `Reviewed ${found} nearby`
    : ai.status === 'processing'
      ? 'Checking local plumbing companies'
      : undefined;

  let smsDetail: string | undefined;
  if (smsFailed) smsDetail = sms?.lastError || 'SMS failed to send';
  else if (sms?.status === 'confirmed' || request.ownerConfirmed) smsDetail = 'Owner replied YES';
  else if (sms?.status === 'declined') smsDetail = 'Owner replied NO — on hold';
  else if (smsSent && sms?.ownerPhone) smsDetail = `Sent to ${sms.ownerPhone} — reply YES to continue`;
  else if (smsSent) smsDetail = 'Waiting for the owner to reply YES';

  let callLabel = 'Placing a scheduling call';
  let callDetail: string | undefined;
  if (callDone) {
    callLabel = 'Scheduling call placed';
    callDetail = providerName ? `Connected with ${providerName}` : undefined;
  } else if (scheduled) {
    callLabel = 'Scheduling call placed';
  } else if (awaitingYes) {
    callDetail = providerName
      ? `Ready to call ${providerName} after YES`
      : 'Ready to call after the owner replies YES';
  } else if (ai.status === 'awaiting_operator_dispatch' && providerName) {
    callDetail = `Shortlist ready — next call is ${providerName}`;
  } else if (identified) {
    callDetail = providerName ? `Preparing to call ${providerName}` : undefined;
  }

  return [
    {
      id: 'ticket',
      label: 'Ticket opened',
      detail: request.priority ? `${String(request.priority)} plumbing` : 'Emergency plumbing',
      state: stateAt(0, done, activeIndex),
      time: formatShortDate(request.createdAt),
    },
    {
      id: 'search',
      label: searchDone ? 'Plumber search finished' : 'Searching for a plumber',
      detail: searchDetail,
      state: stateAt(1, done, activeIndex),
      time: searchDone ? formatShortDate(request.updatedAt || request.createdAt) : undefined,
    },
    {
      id: 'identify',
      label: identified ? 'Plumber identified' : 'Identifying plumber',
      detail: identified ? providerName : undefined,
      state: stateAt(2, done, activeIndex),
    },
    {
      id: 'sms',
      label: smsSent || smsFailed ? 'Owner text sent' : 'Texting the owner',
      detail: smsDetail,
      state: stateAt(3, done, activeIndex),
      time: formatShortDate(sms?.sentAt),
    },
    {
      id: 'call',
      label: callLabel,
      detail: callDetail,
      state: stateAt(4, done, activeIndex),
      time: formatShortDate(ai.callDetails?.initiatedAt || ai.operatorCall?.calledAt),
    },
  ];
}
