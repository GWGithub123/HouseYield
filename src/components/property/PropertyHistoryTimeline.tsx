import React, { useMemo, useState } from 'react';
import { FileText, History, Hammer, ShieldCheck, Wrench, Search } from 'lucide-react';
import {
  HISTORY_EVENT_META,
  groupTimelineByYear,
  type HistoryEventKind,
  type PropertyHistoryEvent,
} from '../../services/propertyHealthTimeline';
import { HEALTH_EVIDENCE_META, PROPERTY_HEALTH_CATEGORY_META } from '../../types/propertyHealth';

/**
 * The building's history in one column, newest first.
 *
 * Grouped by year with each year's spend, because the pattern is what carries
 * the information: three plumbing calls in one year reads as a system going
 * rather than three unrelated inconveniences.
 */

const KIND_ICON: Record<HistoryEventKind, React.ReactNode> = {
  permit: <FileText size={12} />,
  install: <Hammer size={12} />,
  repair: <Wrench size={12} />,
  service: <ShieldCheck size={12} />,
  inspection: <Search size={12} />,
  document: <FileText size={12} />,
};

const TONE_CLASS: Record<'positive' | 'info' | 'warn' | 'neutral', string> = {
  positive: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  info: 'border-blue-200 bg-blue-50 text-blue-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  neutral: 'border-slate-200 bg-slate-50 text-slate-600',
};

export default function PropertyHistoryTimeline({
  events,
}: {
  events: PropertyHistoryEvent[];
}) {
  const [kindFilter, setKindFilter] = useState<'all' | HistoryEventKind>('all');

  const filtered = useMemo(
    () => (kindFilter === 'all' ? events : events.filter((event) => event.kind === kindFilter)),
    [events, kindFilter],
  );

  const groups = useMemo(() => groupTimelineByYear(filtered), [filtered]);

  const presentKinds = useMemo(() => {
    const kinds = new Set(events.map((event) => event.kind));
    return (Object.keys(HISTORY_EVENT_META) as HistoryEventKind[]).filter((kind) => kinds.has(kind));
  }, [events]);

  const totalSpend = events.reduce((sum, event) => sum + (event.amountUsd ?? 0), 0);

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)]"
      data-testid="property-history-timeline"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-slate-500">
            <History size={13} />
            <span className="text-[11px] font-bold uppercase tracking-[0.18em]">
              Property history
            </span>
          </div>
          <h5 className="mt-0.5 text-[15px] font-bold text-slate-950">
            {events.length} record{events.length === 1 ? '' : 's'} on this building
          </h5>
        </div>

        {totalSpend > 0 ? (
          <div className="text-right">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Recorded spend
            </div>
            <div className="text-base font-bold tabular-nums text-slate-900">
              ${Math.round(totalSpend).toLocaleString()}
            </div>
          </div>
        ) : null}
      </div>

      {presentKinds.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setKindFilter('all')}
            className={`rounded-full border px-2 py-0.5 text-[10px] font-bold transition ${
              kindFilter === 'all'
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
            }`}
          >
            All
          </button>
          {presentKinds.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => setKindFilter(kind)}
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold transition ${
                kindFilter === kind
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400'
              }`}
            >
              {HISTORY_EVENT_META[kind].label}
            </button>
          ))}
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-8 text-center">
          <p className="mx-auto max-w-md text-[12px] leading-snug text-slate-600">
            Nothing on the record yet. Permits fill this in automatically, and every receipt you
            upload adds to it.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          {groups.map((group) => (
            <div key={group.year}>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold tabular-nums text-slate-900">
                  {group.year}
                </span>
                <span className="h-px flex-1 bg-slate-200" />
                {group.spendUsd > 0 ? (
                  <span className="text-[11px] font-bold tabular-nums text-slate-500">
                    ${Math.round(group.spendUsd).toLocaleString()}
                  </span>
                ) : null}
              </div>

              <ol className="mt-2 space-y-1.5">
                {group.events.map((event) => {
                  const meta = HISTORY_EVENT_META[event.kind];
                  return (
                    <li
                      key={event.id}
                      className="flex items-start gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2"
                    >
                      <span
                        className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border ${TONE_CLASS[meta.tone]}`}
                      >
                        {KIND_ICON[event.kind]}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-[12.5px] font-bold text-slate-950">
                            {event.title}
                          </span>
                          {event.category ? (
                            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                              {PROPERTY_HEALTH_CATEGORY_META[event.category].label}
                            </span>
                          ) : null}
                        </div>

                        {event.detail ? (
                          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-slate-600">
                            {event.detail}
                          </p>
                        ) : null}

                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-slate-500">
                          <span className="tabular-nums">{event.occurredAt}</span>
                          {event.vendor ? <span>· {event.vendor}</span> : null}
                          {event.evidence ? (
                            <span title={HEALTH_EVIDENCE_META[event.evidence].label}>
                              · {HEALTH_EVIDENCE_META[event.evidence].short}
                            </span>
                          ) : null}
                          {event.corroboratedBy ? (
                            <span
                              className="font-semibold text-emerald-700"
                              title={event.corroboratedBy}
                            >
                              · Permit on file
                            </span>
                          ) : null}
                        </div>
                      </div>

                      {event.amountUsd ? (
                        <span className="shrink-0 text-[12px] font-bold tabular-nums text-slate-900">
                          ${Math.round(event.amountUsd).toLocaleString()}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
