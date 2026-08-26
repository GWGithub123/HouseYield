import { CalendarClock, Package, ShieldCheck, Wrench } from 'lucide-react';
import type { MaintenancePhoto, ServiceRecord } from './ticketTypes';

function money(value: number | null | undefined, currency = 'USD') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(value));
}

function PhotoStrip({ label, photos }: { label: string; photos: MaintenancePhoto[] }) {
  if (!photos.length) return null;

  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
        {photos.map((photo) => (
          <a key={photo.url} href={photo.url} target="_blank" rel="noreferrer" className="block">
            <img
              src={photo.url}
              alt={photo.name || label}
              className="h-16 w-full rounded-lg border border-slate-200 object-cover transition hover:opacity-80"
            />
          </a>
        ))}
      </div>
    </div>
  );
}

interface ServiceRecordPanelProps {
  record: ServiceRecord;
  currency?: string;
  formatDate: (value?: string | null) => string;
}

/**
 * The completed-visit record: what was diagnosed, what was done, which parts went in,
 * what it cost, and what is under warranty. This is the data layer's raw material.
 */
export default function ServiceRecordPanel({ record, currency = 'USD', formatDate }: ServiceRecordPanelProps) {
  const parts = record.parts || [];
  const photos = record.photos || { before: [], after: [], parts: [], receipt: [] };
  const hasCosts = [record.totals?.parts, record.totals?.labor, record.totals?.total].some(
    (value) => value !== null && value !== undefined,
  );

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-slate-600">
        <span>
          <span className="text-slate-500">Completed:</span> {formatDate(record.completedAt)}
        </span>
        {record.providerName && (
          <span>
            <span className="text-slate-500">Provider:</span> {record.providerName}
          </span>
        )}
        {record.completedBy && (
          <span>
            <span className="text-slate-500">Logged by:</span> {record.completedBy}
          </span>
        )}
      </div>

      {record.diagnosis && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Diagnosis</div>
          <p className="leading-relaxed text-slate-800">{record.diagnosis}</p>
        </div>
      )}

      {record.workPerformed && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <Wrench className="h-3 w-3" /> Work performed
          </div>
          <p className="leading-relaxed text-slate-800">{record.workPerformed}</p>
        </div>
      )}

      {parts.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <Package className="h-3 w-3" /> Parts &amp; materials
          </div>
          <div className="divide-y divide-slate-100">
            {parts.map((part, index) => (
              <div key={`${part.partNumber || part.name}-${index}`} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900">{part.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      {part.manufacturer && <span>{part.manufacturer}</span>}
                      {part.modelNumber && <span>Model {part.modelNumber}</span>}
                      {part.partNumber && <span>Part #{part.partNumber}</span>}
                      {part.warrantyMonths ? <span>{part.warrantyMonths} mo warranty</span> : null}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xs text-slate-500">
                      {part.quantity} × {money(part.unitCost, currency)}
                    </div>
                    <div className="font-semibold text-slate-900">
                      {money((Number(part.quantity) || 0) * (Number(part.unitCost) || 0), currency)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasCosts && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="space-y-1.5">
            <div className="flex justify-between text-slate-600">
              <span>Parts</span>
              <span>{money(record.totals?.parts, currency)}</span>
            </div>
            <div className="flex justify-between text-slate-600">
              <span>
                Labor
                {record.labor?.hours ? ` (${record.labor.hours}h${record.labor.rate ? ` @ ${money(record.labor.rate, currency)}/h` : ''})` : ''}
              </span>
              <span>{money(record.totals?.labor, currency)}</span>
            </div>
            {record.totals?.tax ? (
              <div className="flex justify-between text-slate-600">
                <span>Tax</span>
                <span>{money(record.totals.tax, currency)}</span>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-slate-200 pt-1.5 font-semibold text-slate-900">
              <span>Total</span>
              <span>{money(record.totals?.total, currency)}</span>
            </div>
          </div>
        </div>
      )}

      {(record.warranty?.months || record.warranty?.terms) && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
            <ShieldCheck className="h-3 w-3" /> Warranty
          </div>
          <div className="text-sm text-emerald-900">
            {record.warranty.months ? `${record.warranty.months} months` : 'Covered'}
            {record.warranty.expiresAt ? ` · through ${formatDate(record.warranty.expiresAt)}` : ''}
          </div>
          {record.warranty.terms && (
            <p className="mt-1 text-xs leading-relaxed text-emerald-800">{record.warranty.terms}</p>
          )}
        </div>
      )}

      {record.followUpRecommended && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            Follow-up recommended
            {record.followUpDueAt ? ` by ${formatDate(record.followUpDueAt)}` : ''}.
            {record.notes ? ` ${record.notes}` : ''}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <PhotoStrip label="Before" photos={photos.before || []} />
        <PhotoStrip label="After" photos={photos.after || []} />
        <PhotoStrip label="Parts installed" photos={photos.parts || []} />
        <PhotoStrip label="Receipts" photos={photos.receipt || []} />
      </div>
    </div>
  );
}
