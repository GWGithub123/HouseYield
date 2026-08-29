import { Check, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  buildFloodDispatchFeed,
  type DispatchFeedItem,
} from '../maintenance/floodDispatchFeed';
import { buildProgressSteps } from '../maintenance/progressSteps';
import type { MaintenanceTicket } from '../maintenance/ticketTypes';

function FeedDot({ item }: { item: DispatchFeedItem }) {
  if (item.state === 'complete') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
    );
  }
  if (item.state === 'active') {
    return (
      <span className="flex h-5 w-5 items-center justify-center rounded-full border-2 border-emerald-500 bg-white text-emerald-600 ring-4 ring-emerald-100">
        <Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.5} />
      </span>
    );
  }
  return <span className="h-5 w-5 rounded-full border-2 border-slate-200 bg-white" />;
}

function FeedRow({ item, last }: { item: DispatchFeedItem; last: boolean }) {
  const labelClass = item.state === 'active'
    ? 'font-semibold text-slate-900'
    : item.state === 'complete'
      ? 'font-medium text-slate-800'
      : 'text-slate-400';

  return (
    <li className="relative flex gap-2.5 pb-3 last:pb-0">
      {!last && (
        <span
          className={`absolute left-[9px] top-5 h-[calc(100%-8px)] w-px ${
            item.state === 'complete' ? 'bg-emerald-400' : 'bg-slate-200'
          }`}
          aria-hidden="true"
        />
      )}
      <FeedDot item={item} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-start justify-between gap-2">
          <p className={`text-[12px] leading-snug ${labelClass}`}>{item.label}</p>
          {item.time ? (
            <span className="shrink-0 text-[10px] text-slate-400">{item.time}</span>
          ) : item.state === 'active' ? (
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-emerald-600">Live</span>
          ) : null}
        </div>
        {item.detail && (
          <p className={`mt-0.5 text-[11px] leading-snug ${item.state === 'pending' ? 'text-slate-300' : 'text-slate-500'}`}>
            {item.detail}
          </p>
        )}
      </div>
    </li>
  );
}

export default function FloodDispatchFeed({
  request,
  alertMessage,
}: {
  request: MaintenanceTicket | null;
  alertMessage?: string;
}) {
  const items = buildFloodDispatchFeed(request);
  const live = items.some((item) => item.state === 'active');
  const later = request
    ? buildProgressSteps(request).filter((step) => ['scheduled', 'performed', 'paid'].includes(step.id))
    : [];
  const provider = request?.aiAutomation?.selectedProvider;
  const issue = String(request?.description || alertMessage || 'Flood / leak detected')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const shortIssue = issue.split(/(?<=[.!?])\s+/)[0] || issue;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Dispatch</p>
        {live && (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-700">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            AI working
          </span>
        )}
      </div>

      <p className="text-[12px] font-medium leading-snug text-slate-800">
        {shortIssue.length > 120 ? `${shortIssue.slice(0, 117)}…` : shortIssue}
      </p>

      <ol className="m-0 list-none p-0">
        {items.map((item, index) => (
          <FeedRow key={item.id} item={item} last={index === items.length - 1} />
        ))}
      </ol>

      {provider?.name && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Provider</p>
          <p className="mt-0.5 text-[12px] font-semibold text-slate-900">{provider.name}</p>
          {provider.phone && (
            <a href={`tel:${provider.phone}`} className="mt-0.5 inline-block text-[11px] font-medium text-blue-700 hover:underline">
              {provider.phone}
            </a>
          )}
        </div>
      )}

      {later.length > 0 && (
        <div className="border-t border-slate-100 pt-2">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Then</p>
          <div className="space-y-1">
            {later.map((step) => (
              <div key={step.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className={step.state === 'complete' ? 'text-slate-700' : 'text-slate-400'}>{step.label}</span>
                <span className={step.state === 'complete' ? 'text-emerald-600' : step.state === 'active' ? 'text-emerald-600' : 'text-slate-300'}>
                  {step.state === 'complete' ? (step.dateLabel || 'Done') : step.state === 'active' ? 'Next' : 'Later'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {request?.id && (
        <Link
          to="/property-management?section=maintenance"
          className="inline-block text-[11px] font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          Full ticket
        </Link>
      )}
    </div>
  );
}
