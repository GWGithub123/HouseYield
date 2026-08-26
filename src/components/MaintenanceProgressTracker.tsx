import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, Phone, Search, Sparkles } from 'lucide-react';
import ProviderShortlist from './maintenance/ProviderShortlist';
import ServiceRecordPanel from './maintenance/ServiceRecordPanel';
import { ACCESS_METHOD_LABELS } from '../services/maintenanceApi';
import {
  OPERATOR_CALL_OUTCOME_LABELS,
  type MaintenanceTicket,
} from './maintenance/ticketTypes';
import {
  buildProgressSteps,
  formatShortDate,
  formatVisitWindow,
  nextActionableStep,
  type ProgressStep,
  type StepId,
} from './maintenance/progressSteps';

/** Kept as a named export for existing callers that type their request objects. */
export type MaintenanceProgressRequest = MaintenanceTicket;

interface TranscriptLine {
  role: string;
  text: string;
  at?: string;
}

interface MaintenanceProgressTrackerProps {
  request: MaintenanceTicket;
  baseUrl?: string;
  formatDate: (dateStr?: string | null) => string;
  formatCurrency: (value: number | null | undefined, currency?: string) => string;
}

function completedStepCount(steps: ProgressStep[]) {
  return steps.filter((step) => step.state === 'complete').length;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 text-xs font-medium text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-slate-800">{children}</span>
    </div>
  );
}

export default function MaintenanceProgressTracker({
  request,
  baseUrl = '',
  formatDate,
  formatCurrency,
}: MaintenanceProgressTrackerProps) {
  const steps = buildProgressSteps(request);
  const completedCount = completedStepCount(steps);
  const activeStepIndex = steps.findIndex((step) => step.state === 'active');
  const trackSegmentCount = steps.length - 1;
  const solidEndRatio = trackSegmentCount > 0 ? Math.max(0, (completedCount - 1) / trackSegmentCount) : 0;
  const dashedEndRatio = activeStepIndex >= 0 ? activeStepIndex / trackSegmentCount : solidEndRatio;
  const hasDashedSegment = activeStepIndex >= 0 && dashedEndRatio > solidEndRatio;

  const defaultSelected = nextActionableStep(steps);

  const [selectedStepId, setSelectedStepId] = useState<StepId>(defaultSelected);
  const [transcript, setTranscript] = useState<TranscriptLine[] | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const ai = request.aiAutomation;
  const callSid = ai.callDetails?.callSid || request.callOutcome?.callSid || '';

  const loadTranscript = useCallback(async () => {
    if (!callSid) {
      setTranscript([]);
      setTranscriptError(null);
      return;
    }

    setTranscriptLoading(true);
    setTranscriptError(null);

    try {
      const response = await fetch(`${baseUrl}/api/maintenance/requests/${encodeURIComponent(request.id)}/call-transcript`);
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to load call transcript.');
      }

      setTranscript(Array.isArray(data.transcript) ? data.transcript : []);
    } catch (error: any) {
      setTranscript(null);
      setTranscriptError(error.message || 'Failed to load call transcript.');
    } finally {
      setTranscriptLoading(false);
    }
  }, [baseUrl, callSid, request.id]);

  const handleSelectStep = (stepId: StepId) => {
    setSelectedStepId(stepId);
    if (stepId === 'connected' && callSid && transcript === null && !transcriptLoading) {
      void loadTranscript();
    }
  };

  useEffect(() => {
    if (defaultSelected === 'connected' && callSid && transcript === null && !transcriptLoading) {
      void loadTranscript();
    }
  }, [callSid, defaultSelected, loadTranscript, transcript, transcriptLoading]);

  const selectedStep = steps.find((step) => step.id === selectedStepId) || steps[0];
  const access = request.propertyAccess;
  const shortlist = ai.providerShortlist || [];

  const renderStepDetails = () => {
    switch (selectedStepId) {
      case 'reported':
        return (
          <div className="space-y-3">
            <div className="space-y-2">
              <Detail label="Reported">{formatDate(request.createdAt)}</Detail>
              <Detail label="Category">{request.category}</Detail>
              {request.location && <Detail label="Location">{request.location}</Detail>}
              {request.submittedBy?.name && (
                <Detail label="Reported by">
                  {request.submittedBy.name}
                  {request.submittedBy.role ? ` (${request.submittedBy.role})` : ''}
                </Detail>
              )}
              {request.tenantName && !request.submittedBy?.name && (
                <Detail label="Tenant">{request.tenantName}</Detail>
              )}
              {request.tenantAvailability && (
                <Detail label="Availability">{request.tenantAvailability}</Detail>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-800">
              {request.description}
            </div>

            {access && access.method !== 'unspecified' && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <KeyRound className="h-3 w-3" /> Property access
                </div>
                <div className="text-sm text-slate-800">{ACCESS_METHOD_LABELS[access.method]}</div>
                {access.instructions && (
                  <p className="mt-1 text-xs leading-relaxed text-slate-600">{access.instructions}</p>
                )}
                {access.contactName && (
                  <p className="mt-1 text-xs text-slate-600">
                    Ask for {access.contactName}
                    {access.contactPhone ? ` · ${access.contactPhone}` : ''}
                  </p>
                )}
              </div>
            )}

            {request.intake?.mode === 'ai_chat' && request.intake.transcript?.length ? (
              <details className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
                <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-indigo-600">
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="h-3 w-3" /> Intake conversation
                  </span>
                </summary>
                <div className="mt-2 max-h-56 space-y-2 overflow-y-auto">
                  {request.intake.transcript.map((line, index) => (
                    <div key={`${line.at || index}-${index}`}>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                        {line.role === 'assistant' ? 'Assistant' : 'Reported by'}
                      </div>
                      <div className="text-xs leading-relaxed text-slate-700">{line.content}</div>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}

            {request.photos && request.photos.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Photos
                </div>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                  {request.photos.map((photo) => (
                    <a key={photo.url} href={photo.url} target="_blank" rel="noreferrer">
                      <img
                        src={photo.url}
                        alt={photo.name}
                        className="h-16 w-full rounded-lg border border-slate-200 object-cover transition hover:opacity-80"
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {request.ownerSmsNotifications?.ownerPhone && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Owner SMS confirmation
                </div>
                <div className="space-y-1 text-sm text-slate-700">
                  <div>
                    <span className="text-slate-500">Sent to:</span> {request.ownerSmsNotifications.ownerPhone}
                  </div>
                  <div>
                    <span className="text-slate-500">Status:</span>{' '}
                    {ai.status === 'awaiting_owner_confirmation' ? (
                      <span className="font-medium text-blue-700">Waiting for YES reply before dispatch</span>
                    ) : request.ownerSmsNotifications.status === 'confirmed' || request.ownerConfirmed ? (
                      <span className="font-medium text-emerald-700">Confirmed by text</span>
                    ) : request.ownerSmsNotifications.status === 'declined' ? (
                      <span className="font-medium text-amber-700">On hold (owner replied NO)</span>
                    ) : request.ownerSmsNotifications.status === 'pending' ? (
                      <span className="font-medium text-blue-700">Awaiting YES reply</span>
                    ) : request.ownerSmsNotifications.status === 'send_failed' ? (
                      <span className="font-medium text-red-700">SMS failed to send</span>
                    ) : (
                      'Not sent'
                    )}
                  </div>
                  {request.ownerSmsNotifications.lastReply && (
                    <div>
                      <span className="text-slate-500">Owner reply:</span> {request.ownerSmsNotifications.lastReply}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );

      case 'search':
        return (
          <div className="space-y-3">
            <p className="text-sm text-slate-700">
              {ai.providerSearch
                ? `Searched ${ai.providerSearch.totalFound} providers near this property and ran an AI review analysis on ${ai.providerSearch.analyzedCount}.`
                : shortlist.length
                  ? `${shortlist.length} candidates shortlisted for this ticket.`
                  : ai.status === 'processing'
                    ? 'Searching for qualified providers near this property.'
                    : 'Provider search has not started yet. It begins automatically after the issue is submitted.'}
            </p>

            {ai.error && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{ai.error}</div>
            )}

            {ai.status === 'awaiting_operator_dispatch' && (
              <div className="flex items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3">
                <Search className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                <div className="text-sm text-indigo-900">
                  Shortlist ready. The HouseYield team is calling to confirm pricing and availability.
                </div>
              </div>
            )}

            {(shortlist.length > 0 || ai.selectedProvider) && (
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Ranked candidates
                </div>
                <ProviderShortlist
                  providers={shortlist.length ? shortlist : ai.selectedProvider ? [ai.selectedProvider] : []}
                  selectedName={ai.selectedProvider?.name}
                />
              </div>
            )}
          </div>
        );

      case 'connected': {
        const operatorCall = ai.operatorCall;

        return (
          <div className="space-y-3">
            {operatorCall?.calledAt ? (
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900">
                    {operatorCall.providerName || ai.selectedProvider?.name || 'Provider'}
                  </span>
                  {operatorCall.outcome && OPERATOR_CALL_OUTCOME_LABELS[operatorCall.outcome as keyof typeof OPERATOR_CALL_OUTCOME_LABELS] && (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                      {OPERATOR_CALL_OUTCOME_LABELS[operatorCall.outcome as keyof typeof OPERATOR_CALL_OUTCOME_LABELS]}
                    </span>
                  )}
                </div>
                {(operatorCall.providerPhone || ai.selectedProvider?.phone) && (
                  <div className="mt-1 flex items-center gap-1.5 text-sm text-slate-600">
                    <Phone className="h-3.5 w-3.5" />
                    {operatorCall.providerPhone || ai.selectedProvider?.phone}
                  </div>
                )}
                <div className="mt-1 text-xs text-slate-500">
                  Called {formatDate(operatorCall.calledAt)}
                  {operatorCall.calledBy ? ` by ${operatorCall.calledBy}` : ''}
                </div>
                {operatorCall.notes && (
                  <p className="mt-2 rounded-lg bg-slate-50 p-2.5 text-sm leading-relaxed text-slate-700">
                    {operatorCall.notes}
                  </p>
                )}
              </div>
            ) : ai.selectedProvider ? (
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="font-medium text-slate-900">{ai.selectedProvider.name}</div>
                {ai.selectedProvider.phone && (
                  <div className="mt-1 flex items-center gap-1.5 text-sm text-slate-600">
                    <Phone className="h-3.5 w-3.5" /> {ai.selectedProvider.phone}
                  </div>
                )}
                {ai.callDetails?.initiatedAt && (
                  <div className="mt-1 text-xs text-slate-500">
                    Call started {formatDate(ai.callDetails.initiatedAt)}
                  </div>
                )}
                {ai.scheduledCall?.scheduledFor && (
                  <div className="mt-2 rounded-lg bg-indigo-50 p-2 text-xs text-indigo-700">
                    Call queued for business hours: {formatDate(ai.scheduledCall.scheduledFor)}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                No provider has been reached yet. The HouseYield team calls the shortlist and logs the outcome here.
              </p>
            )}

            {ai.callError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{ai.callError}</div>
            )}

            {callSid && (
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Call transcript
                </div>
                {transcriptLoading && <div className="text-sm text-slate-500">Loading transcript…</div>}
                {!transcriptLoading && transcriptError && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    {transcriptError}
                  </div>
                )}
                {!transcriptLoading && transcript && transcript.length === 0 && !transcriptError && (
                  <div className="text-sm text-slate-500">No transcript lines were captured for this call.</div>
                )}
                {!transcriptLoading && transcript && transcript.length > 0 && (
                  <div className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-200 bg-white">
                    {transcript.map((line, index) => (
                      <div key={`${line.at || index}-${index}`} className="px-3 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          {line.role === 'assistant' ? 'HouseYield (Ava)' : 'Provider'}
                        </div>
                        <div className="mt-0.5 text-sm text-slate-800">{line.text}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      }

      case 'scheduled':
        return request.scheduledVisit?.confirmed ? (
          <div className="space-y-2">
            <div className="text-sm font-semibold text-slate-900">
              {formatVisitWindow(request.scheduledVisit)}
            </div>
            {request.scheduledVisit.providerName && (
              <Detail label="Provider">{request.scheduledVisit.providerName}</Detail>
            )}
            {request.scheduledVisit.providerPhone && (
              <Detail label="Phone">{request.scheduledVisit.providerPhone}</Detail>
            )}
            {access && access.method !== 'unspecified' && (
              <Detail label="Access">{ACCESS_METHOD_LABELS[access.method]}</Detail>
            )}
            {request.scheduledVisit.summary && (
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-800">
                {request.scheduledVisit.summary}
              </div>
            )}
            {request.scheduledVisit.googleCalendarUrl && (
              <a
                href={request.scheduledVisit.googleCalendarUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                Add to Google Calendar
              </a>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            {ai.operatorCall?.outcome === 'callback'
              ? 'The provider is checking their schedule and will confirm a window shortly.'
              : ai.operatorCall?.calledAt || ai.callInitiated
                ? 'Waiting on the provider to confirm a visit date and time.'
                : 'A visit has not been scheduled yet.'}
          </p>
        );

      case 'performed':
        if (request.serviceRecord?.completedAt) {
          return (
            <ServiceRecordPanel
              record={request.serviceRecord}
              currency={(request.paymentWorkflow?.currency || 'usd').toUpperCase()}
              formatDate={formatDate}
            />
          );
        }

        return request.serviceCompletion?.completedAt ? (
          <div className="space-y-2">
            <Detail label="Completed">{formatDate(request.serviceCompletion.completedAt)}</Detail>
            {request.serviceCompletion.completedBy && (
              <Detail label="Logged by">{request.serviceCompletion.completedBy}</Detail>
            )}
            {request.serviceCompletion.notes && (
              <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm leading-relaxed text-slate-800">
                {request.serviceCompletion.notes}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            {request.scheduledVisit?.confirmed
              ? 'The visit is scheduled. Once the work is done, the parts used, costs, and before/after photos will appear here.'
              : 'Service has not been performed yet.'}
          </p>
        );

      case 'paid':
        return request.paymentWorkflow?.status === 'paid' || request.paymentWorkflow?.ownerChargeSucceededAt ? (
          <div className="space-y-2">
            <div className="text-base font-semibold text-slate-900">
              {formatCurrency(request.paymentWorkflow?.amount, request.paymentWorkflow?.currency)}
            </div>
            <Detail label="Paid">{formatDate(request.paymentWorkflow?.ownerChargeSucceededAt)}</Detail>
            {request.paymentWorkflow?.receiptNumber && (
              <Detail label="Receipt">{request.paymentWorkflow.receiptNumber}</Detail>
            )}
            <div className="flex flex-wrap gap-3 pt-1">
              {request.paymentWorkflow?.ownerInvoiceUrl && (
                <a
                  href={request.paymentWorkflow.ownerInvoiceUrl}
                  className="text-sm font-medium text-blue-600 hover:text-blue-700"
                >
                  Owner receipt
                </a>
              )}
              {request.paymentWorkflow?.receiptUrl && (
                <a
                  href={request.paymentWorkflow.receiptUrl}
                  className="text-sm font-medium text-emerald-600 hover:text-emerald-700"
                >
                  Contractor receipt
                </a>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600">
            {request.paymentWorkflow?.status && request.paymentWorkflow.status !== 'not_started'
              ? `Payment status: ${request.paymentWorkflow.status.replace(/_/g, ' ')}`
              : 'Provider payment has not been processed yet.'}
          </p>
        );

      default:
        return null;
    }
  };

  return (
    <div>
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
        Maintenance progress
      </div>

      {/* Stepper */}
      <div className="relative px-2 pb-1 pt-2">
        <div className="relative h-9">
          <div className="absolute left-4 right-4 top-1/2 h-0.5 -translate-y-1/2 bg-slate-200" aria-hidden="true" />
          {solidEndRatio > 0 && (
            <div
              className="absolute left-4 top-1/2 h-0.5 -translate-y-1/2 bg-emerald-500 transition-all duration-300"
              style={{ width: `calc((100% - 2rem) * ${solidEndRatio})` }}
              aria-hidden="true"
            />
          )}
          {hasDashedSegment && (
            <div
              className="absolute top-1/2 h-0 -translate-y-1/2 border-t-2 border-dashed border-emerald-500"
              style={{
                left: `calc(1rem + (100% - 2rem) * ${solidEndRatio})`,
                width: `calc((100% - 2rem) * ${dashedEndRatio - solidEndRatio})`,
              }}
              aria-hidden="true"
            />
          )}

          <div className="relative grid h-full grid-cols-6 gap-1">
            {steps.map((step, index) => {
              const isSelected = selectedStepId === step.id;
              const circleClass = step.state === 'complete'
                ? 'bg-emerald-600 border-emerald-600 text-white'
                : step.state === 'active'
                  ? 'bg-white border-emerald-500 text-emerald-600 ring-4 ring-emerald-100'
                  : 'bg-white border-slate-300 text-slate-400';

              return (
                <div key={step.id} className="flex items-center justify-center">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSelectStep(step.id);
                    }}
                    className={`ds-focus-ring relative z-10 flex h-9 w-9 items-center justify-center rounded-full border-2 text-xs font-semibold transition-all hover:scale-105 ${circleClass} ${isSelected ? 'scale-110 shadow-sm' : ''}`}
                    title={step.label}
                    aria-label={step.label}
                    aria-pressed={isSelected}
                  >
                    {step.state === 'complete' ? <Check className="h-4 w-4" strokeWidth={2.5} /> : index + 1}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-2 grid grid-cols-6 gap-1">
          {steps.map((step) => {
            const isSelected = selectedStepId === step.id;

            return (
              <div key={step.id} className="flex min-w-0 flex-col items-center text-center">
                <div className={`text-[10px] leading-tight sm:text-xs ${isSelected ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>
                  {step.label}
                </div>
                {(step.dateLabel || step.state === 'active') && (
                  <div className={`mt-0.5 max-w-[5.5rem] text-[10px] leading-tight sm:max-w-none ${step.state === 'complete' ? 'text-emerald-700' : 'text-slate-400'}`}>
                    {step.dateLabel || (step.state === 'active' ? 'In progress' : '')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Step detail + persistent ticket summary, mirroring the digital twin layout */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
            {selectedStep.label}
          </div>
          {renderStepDetails()}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
            Ticket
          </div>
          <div className="space-y-2">
            <Detail label="Property">{request.propertyAddress || '—'}</Detail>
            {request.unit && <Detail label="Unit">{request.unit}</Detail>}
            <Detail label="Category">{request.category}</Detail>
            <Detail label="Priority">
              <span className="capitalize">{request.priority}</span>
            </Detail>
            <Detail label="Status">
              <span className="capitalize">{String(request.status || '').replace(/_/g, ' ')}</span>
            </Detail>
            {request.location && <Detail label="Location">{request.location}</Detail>}
            <Detail label="Opened">{formatDate(request.createdAt)}</Detail>
            {access && access.method !== 'unspecified' && (
              <Detail label="Access">{ACCESS_METHOD_LABELS[access.method]}</Detail>
            )}
          </div>

          {request.triageSummary && (
            <div className="mt-3 border-t border-slate-200 pt-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Dispatch summary
              </div>
              <p className="text-xs leading-relaxed text-slate-700">{request.triageSummary}</p>
            </div>
          )}

          {request.operatorLog && request.operatorLog.length > 0 && (
            <div className="mt-3 border-t border-slate-200 pt-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Activity
              </div>
              <ol className="space-y-1.5">
                {[...request.operatorLog].reverse().slice(0, 6).map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className="text-xs leading-relaxed text-slate-600">
                    <span className="font-medium text-slate-800">
                      {entry.event.replace(/_/g, ' ')}
                    </span>
                    {entry.note ? ` — ${entry.note}` : ''}
                    <span className="block text-[10px] text-slate-400">{formatShortDate(entry.at)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
