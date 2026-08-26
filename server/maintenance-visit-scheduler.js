/**
 * Post-call maintenance visit scheduling:
 * - Extract confirmed visit from voice call transcript
 * - Update Firestore maintenance request
 * - Send confirmation emails with ICS + Google Calendar links
 * - Create Google Calendar events when OAuth calendar scope is available
 */

import 'dotenv/config';
import { loadVoiceCallContext, appendVoiceCallTranscriptLine } from './voice-call-context-store.js';
import { getMaintenanceRequestById, updateMaintenanceScheduledVisit } from './tenant-activity-service.js';
import { sendMaintenanceVisitConfirmationEmail } from './email-service.js';
import { createHouseYieldCalendarEvent } from './gmail-oauth2-secure.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const processedCallSids = new Set();

export { appendVoiceCallTranscriptLine };

function formatIcsDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function buildIcsCalendarInvite({
  uid,
  summary,
  description,
  location,
  startAt,
  endAt,
  organizerEmail,
  attendeeEmails = []
}) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const now = new Date();
  const attendeeLines = attendeeEmails
    .filter(Boolean)
    .map((email) => `ATTENDEE;CN=${email};RSVP=TRUE:mailto:${email}`)
    .join('\r\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HouseYield//Maintenance Scheduling//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcsDate(now)}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${summary.replace(/\r?\n/g, '\\n')}`,
    `DESCRIPTION:${description.replace(/\r?\n/g, '\\n')}`,
    location ? `LOCATION:${location.replace(/\r?\n/g, '\\n')}` : null,
    organizerEmail ? `ORGANIZER;CN=HouseYield:mailto:${organizerEmail}` : null,
    attendeeLines || null,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
}

export function buildGoogleCalendarUrl({ title, details, location, startAt, endAt }) {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    details: details || '',
    location: location || '',
    dates: `${fmt(start)}/${fmt(end)}`
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

async function extractVisitFromTranscript({ transcript, maintenanceContext }) {
  if (!OPENAI_API_KEY) {
    return { ok: false, error: 'OpenAI not configured' };
  }

  const transcriptText = (transcript || [])
    .map((line) => `${line.role === 'assistant' ? 'Ava (HouseYield)' : 'Provider'}: ${line.text}`)
    .join('\n');

  const prompt = `You analyze maintenance scheduling phone calls between a property manager (Ava) and a repair provider.

Maintenance context:
- Issue: ${maintenanceContext?.issue || maintenanceContext?.description || 'Unknown'}
- Property: ${maintenanceContext?.propertyAddress || 'Unknown'}
- Tenant availability preference: ${maintenanceContext?.tenantAvailability || 'Not specified'}
- Provider: ${maintenanceContext?.providerName || 'Unknown'}

Call transcript:
${transcriptText || '(no transcript captured)'}

Extract whether a maintenance visit was scheduled. Return strict JSON:
{
  "visitScheduled": boolean,
  "startAt": "ISO-8601 datetime with timezone offset or null",
  "endAt": "ISO-8601 datetime with timezone offset or null",
  "timezone": "IANA timezone like America/New_York",
  "providerName": "string or null",
  "summary": "one sentence summary of what was agreed",
  "confidence": 0-100
}

Rules:
- visitScheduled=true only if a specific date AND approximate time window was agreed.
- If only vague availability discussed, visitScheduled=false.
- Prefer tenant availability windows when exact time not stated.
- Use America/New_York for Potomac MD unless clearly otherwise.`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Return valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })
  });

  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false, error: data.error?.message || 'No LLM response' };
  }

  try {
    const parsed = JSON.parse(content);
    return { ok: true, extraction: parsed };
  } catch (error) {
    return { ok: false, error: `Invalid JSON from LLM: ${error.message}` };
  }
}

async function resolveOwnerEmail(ownerId, existingEmail = '') {
  if (existingEmail) {
    return existingEmail;
  }
  if (!ownerId) {
    return '';
  }

  try {
    const { getFirestore } = await import('./firebase-admin.js');
    const db = getFirestore();
    const inviteSnap = await db.collection('tenant_invites')
      .where('ownerId', '==', ownerId)
      .limit(1)
      .get();
    if (!inviteSnap.empty) {
      return inviteSnap.docs[0].data()?.ownerEmail || '';
    }
  } catch (error) {
    console.warn('[MaintenanceVisit] Owner email lookup failed:', error.message);
  }

  return '';
}

export async function processCompletedMaintenanceCall({
  callSid,
  callStatus = 'completed',
  durationSeconds = 0
}) {
  if (!callSid || processedCallSids.has(callSid)) {
    return { ok: false, skipped: true, reason: 'already_processed_or_missing_sid' };
  }

  if (!['completed'].includes(String(callStatus).toLowerCase())) {
    return { ok: false, skipped: true, reason: `status_${callStatus}` };
  }

  processedCallSids.add(callSid);
  setTimeout(() => processedCallSids.delete(callSid), 30 * 60 * 1000);

  const stored = await loadVoiceCallContext(callSid, { includeTranscript: true });
  const maintenanceContext = stored?.context || null;
  const transcript = stored?.transcript || [];

  if (!maintenanceContext?.firestoreId) {
    console.warn('[MaintenanceVisit] No firestoreId on call context:', callSid);
    return { ok: false, error: 'missing_firestore_id' };
  }

  const requestResult = await getMaintenanceRequestById(maintenanceContext.firestoreId);
  if (!requestResult.ok || !requestResult.request) {
    return { ok: false, error: requestResult.error || 'request_not_found' };
  }

  const request = requestResult.request;
  if (request.scheduledVisit?.confirmed) {
    return { ok: true, skipped: true, reason: 'already_scheduled' };
  }

  const extractionResult = await extractVisitFromTranscript({
    transcript,
    maintenanceContext: {
      ...maintenanceContext,
      providerName: maintenanceContext.providerName || request.aiAutomation?.selectedProvider?.name
    }
  });

  if (!extractionResult.ok) {
    console.warn('[MaintenanceVisit] Extraction failed:', extractionResult.error);
    await updateMaintenanceScheduledVisit(maintenanceContext.firestoreId, {
      callOutcome: {
        callSid,
        callStatus,
        durationSeconds,
        processedAt: new Date().toISOString(),
        visitScheduled: false,
        extractionError: extractionResult.error,
        transcriptLineCount: transcript.length
      }
    });
    return extractionResult;
  }

  const extraction = extractionResult.extraction;
  if (!extraction?.visitScheduled || !extraction?.startAt) {
    console.log('[MaintenanceVisit] No confirmed visit extracted for', callSid);
    await updateMaintenanceScheduledVisit(maintenanceContext.firestoreId, {
      callOutcome: {
        callSid,
        callStatus,
        durationSeconds,
        processedAt: new Date().toISOString(),
        visitScheduled: false,
        extraction,
        transcriptLineCount: transcript.length
      }
    });
    return { ok: true, visitScheduled: false, extraction };
  }

  const startAt = new Date(extraction.startAt);
  let endAt = extraction.endAt ? new Date(extraction.endAt) : new Date(startAt.getTime() + 2 * 60 * 60 * 1000);
  if (Number.isNaN(startAt.getTime())) {
    return { ok: false, error: 'invalid_start_at' };
  }
  if (Number.isNaN(endAt.getTime()) || endAt <= startAt) {
    endAt = new Date(startAt.getTime() + 2 * 60 * 60 * 1000);
  }

  const timezone = extraction.timezone || 'America/New_York';
  const providerName = extraction.providerName
    || maintenanceContext.providerName
    || request.aiAutomation?.selectedProvider?.name
    || 'Service provider';
  const ownerEmail = await resolveOwnerEmail(request.ownerId, maintenanceContext.ownerEmail || request.ownerEmail);
  const tenantEmail = request.tenantEmail || maintenanceContext.tenantEmail;
  const propertyAddress = request.propertyAddress || maintenanceContext.propertyAddress;
  const unit = request.unit || maintenanceContext.unitNumber || '';
  const fullAddress = unit ? `${propertyAddress} (${unit})` : propertyAddress;
  const visitTitle = `Maintenance visit — ${request.category || 'Repair'}`;
  const visitSummary = extraction.summary || `Scheduled ${request.category || 'maintenance'} visit at ${fullAddress}`;
  const visitDescription = [
    `Issue: ${request.description || maintenanceContext.issue || 'See maintenance request'}`,
    `Provider: ${providerName}`,
    `Tenant: ${request.tenantName || maintenanceContext.tenantName || 'Tenant'}`,
    `Requested availability: ${request.tenantAvailability || maintenanceContext.tenantAvailability || 'N/A'}`
  ].join('\n');

  const icsContent = buildIcsCalendarInvite({
    uid: `${callSid}@houseyield.app`,
    summary: visitTitle,
    description: visitDescription,
    location: fullAddress,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    organizerEmail: process.env.HOUSEYIELD_EMAIL_ADDRESS || process.env.GMAIL_SENDER_EMAIL || 'admin@myhouseyield.com',
    attendeeEmails: [tenantEmail, ownerEmail].filter(Boolean)
  });

  const googleCalendarUrl = buildGoogleCalendarUrl({
    title: visitTitle,
    details: visitDescription,
    location: fullAddress,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString()
  });

  const calendarAttendees = [tenantEmail, ownerEmail].filter(Boolean);
  const calendarEvent = await createHouseYieldCalendarEvent({
    summary: visitTitle,
    description: visitDescription,
    location: fullAddress,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone,
    attendees: calendarAttendees
  });

  const emailResults = { tenant: null, owner: null };
  const emailPayload = {
    visitTitle,
    visitSummary,
    visitDescription,
    propertyAddress: fullAddress,
    providerName,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone,
    googleCalendarUrl,
    icsContent
  };

  if (tenantEmail) {
    emailResults.tenant = await sendMaintenanceVisitConfirmationEmail({
      to: tenantEmail,
      recipientName: request.tenantName || maintenanceContext.tenantName || 'Tenant',
      recipientRole: 'tenant',
      ...emailPayload
    });
  }

  if (ownerEmail) {
    emailResults.owner = await sendMaintenanceVisitConfirmationEmail({
      to: ownerEmail,
      recipientName: maintenanceContext.ownerName || 'Property Owner',
      recipientRole: 'owner',
      tenantName: request.tenantName || maintenanceContext.tenantName,
      ...emailPayload
    });
  }

  const scheduledVisit = {
    confirmed: true,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    timezone,
    providerName,
    providerPhone: request.aiAutomation?.selectedProvider?.phone || maintenanceContext.providerPhone || null,
    summary: visitSummary,
    callSid,
    extractionConfidence: extraction.confidence ?? null,
    googleCalendarUrl,
    calendarEventId: calendarEvent.ok ? calendarEvent.id : null,
    calendarEventLink: calendarEvent.ok ? calendarEvent.htmlLink : null,
    calendarInviteSent: calendarEvent.invitesSent || false,
    confirmationEmails: {
      tenant: emailResults.tenant?.ok ? { sentAt: new Date().toISOString(), messageId: emailResults.tenant.messageId } : { error: emailResults.tenant?.error },
      owner: emailResults.owner?.ok ? { sentAt: new Date().toISOString(), messageId: emailResults.owner.messageId } : { error: emailResults.owner?.error }
    },
    confirmedAt: new Date().toISOString()
  };

  await updateMaintenanceScheduledVisit(maintenanceContext.firestoreId, {
    status: 'scheduled',
    scheduledVisit,
    callOutcome: {
      callSid,
      callStatus,
      durationSeconds,
      processedAt: new Date().toISOString(),
      visitScheduled: true,
      extraction,
      transcriptLineCount: transcript.length
    }
  });

  try {
    const { getMaintenanceRequestById } = await import('./tenant-activity-service.js');
    const { notifyMaintenanceOwnerVisitScheduled } = await import('./services/maintenanceOwnerSmsService.js');
    const persisted = await getMaintenanceRequestById(maintenanceContext.firestoreId);
    if (persisted.ok && persisted.request) {
      await notifyMaintenanceOwnerVisitScheduled({
        ...persisted.request,
        scheduledVisit,
      });
    }
  } catch (smsError) {
    console.warn('[MaintenanceVisit] Owner visit-scheduled SMS failed:', smsError.message);
  }

  console.log('[MaintenanceVisit] ✅ Visit scheduled for', maintenanceContext.firestoreId, scheduledVisit.startAt);
  return {
    ok: true,
    visitScheduled: true,
    requestId: maintenanceContext.firestoreId,
    scheduledVisit,
    emailResults,
    calendarEvent
  };
}
