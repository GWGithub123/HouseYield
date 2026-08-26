import { AlertTriangle, CheckCircle2, MapPin, Sparkles } from 'lucide-react';
import {
  ACCESS_METHOD_LABELS,
  formatAvailabilitySelections,
  type AvailabilitySelection,
  type MaintenancePhoto,
  type MaintenancePriority,
  type MaintenanceTriage,
  type PropertyAccess,
} from '../../services/maintenanceApi';

export const PRIORITY_STYLES: Record<MaintenancePriority, string> = {
  low: 'border-slate-200 bg-slate-50 text-slate-600',
  normal: 'border-amber-200 bg-amber-50 text-amber-700',
  urgent: 'border-red-200 bg-red-50 text-red-700',
};

export const PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  low: 'Low',
  normal: 'Normal',
  urgent: 'Urgent',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-xs font-medium text-slate-500">{label}</span>
      <span className="min-w-0 flex-1 text-sm text-slate-800">{children}</span>
    </div>
  );
}

interface TicketSummaryCardProps {
  triage: MaintenanceTriage | null;
  propertyAddress?: string;
  access?: PropertyAccess;
  availability?: AvailabilitySelection[];
  photos?: MaintenancePhoto[];
  /** `rail` is the compact live panel; `review` is the full pre-submit summary. */
  variant?: 'rail' | 'review';
}

/**
 * The ticket as the dispatcher will see it. Rendered live beside the intake
 * conversation so the owner watches their words turn into a structured ticket.
 */
export default function TicketSummaryCard({
  triage,
  propertyAddress,
  access,
  availability = [],
  photos = [],
  variant = 'rail',
}: TicketSummaryCardProps) {
  const priority = triage?.priority || 'normal';
  const availabilityLabel = formatAvailabilitySelections(availability);
  const isReview = variant === 'review';

  return (
    <div
      className={[
        'rounded-2xl border bg-gradient-to-br from-indigo-50/70 to-white',
        isReview ? 'border-indigo-200 p-5' : 'border-indigo-100 p-4',
      ].join(' ')}
    >
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-indigo-600" />
        <div className="text-sm font-semibold text-indigo-900">
          {isReview ? 'Your maintenance ticket' : 'Ticket forming'}
        </div>
        <div className="ml-auto rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-600">
          Powered by Gemini
        </div>
      </div>

      {!triage && (
        <p className="text-sm leading-relaxed text-slate-500">
          Describe the issue and this fills in automatically as we talk.
        </p>
      )}

      {triage && (
        <>
          {triage.emergencyLevel === 'call_911' && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <div className="text-sm font-semibold text-red-800">
                Call 911 now. {triage.emergencyGuidance}
              </div>
            </div>
          )}

          {isReview && (triage.ownerSummary || triage.summary) && (
            <div className="mb-4 rounded-xl border border-slate-200 bg-white p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Dispatch summary
              </div>
              <p className="text-sm leading-relaxed text-slate-800">
                {triage.ownerSummary || triage.summary}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Row label="Category">{triage.category || '—'}</Row>
            <Row label="Priority">
              <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[priority]}`}>
                {PRIORITY_LABELS[priority]}
              </span>
            </Row>
            <Row label="Location">{triage.location || 'Not specified'}</Row>
            {propertyAddress && (
              <Row label="Property">
                <span className="inline-flex items-start gap-1">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="text-sm">{propertyAddress}</span>
                </span>
              </Row>
            )}
            {access && access.method !== 'unspecified' && (
              <Row label="Access">
                <span className="text-sm">{ACCESS_METHOD_LABELS[access.method]}</span>
                {access.instructions && (
                  <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                    {access.instructions}
                  </span>
                )}
              </Row>
            )}
            <Row label="Availability">
              <span className={availabilityLabel ? 'text-sm' : 'text-sm text-slate-400'}>
                {availabilityLabel || 'Not selected yet'}
              </span>
            </Row>
            {photos.length > 0 && (
              <Row label="Photos">{photos.length} attached</Row>
            )}
            {!isReview && (
              <Row label="Ready">
                {triage.readyToSubmit ? (
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Enough to dispatch
                  </span>
                ) : (
                  <span className="text-sm text-amber-600">Needs a bit more detail</span>
                )}
              </Row>
            )}
          </div>

          {photos.length > 0 && isReview && (
            <div className="mt-4 grid grid-cols-5 gap-2">
              {photos.map((photo) => (
                <img
                  key={photo.url}
                  src={photo.url}
                  alt={photo.name}
                  className="h-16 w-full rounded-lg border border-slate-200 object-cover"
                />
              ))}
            </div>
          )}

          {triage.suggestedActions && triage.suggestedActions.length > 0 && (
            <div className="mt-4 border-t border-indigo-100 pt-3">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-indigo-500">
                Do this in the meantime
              </div>
              <ul className="space-y-1 text-xs leading-relaxed text-slate-700">
                {triage.suggestedActions.map((action) => (
                  <li key={action} className="flex gap-1.5">
                    <span className="text-indigo-400">–</span>
                    <span>{action}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
