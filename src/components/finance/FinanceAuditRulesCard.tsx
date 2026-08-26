import React, { useState } from 'react';
import { BookOpenCheck, ChevronDown, ExternalLink } from 'lucide-react';
import type { FinanceAuditRulesSources } from '../../services/financeAuditClient';

interface FinanceAuditRulesCardProps {
  rules: FinanceAuditRulesSources | null;
  loading?: boolean;
  /** Optional override for the rules version pill (e.g. the snapshot-attached version). */
  attachedRulesVersion?: string | null;
}

function hostnameOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function fmtShortDate(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(`${value}`.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function freshnessPill(status?: string) {
  const value = String(status || '').toLowerCase();
  if (value === 'current') {
    return { label: 'Current', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' };
  }
  if (value === 'stale') {
    return { label: 'Stale', cls: 'border-rose-200 bg-rose-50 text-rose-700' };
  }
  if (value === 'provisional' || value === 'mismatch') {
    return { label: value === 'mismatch' ? 'Year mismatch' : 'Provisional', cls: 'border-amber-200 bg-amber-50 text-amber-700' };
  }
  if (value === 'unapproved') {
    return { label: 'Unapproved', cls: 'border-rose-200 bg-rose-50 text-rose-700' };
  }
  if (value) {
    return { label: value.replace(/_/g, ' '), cls: 'border-amber-200 bg-amber-50 text-amber-700' };
  }
  return { label: 'Status unknown', cls: 'border-slate-200 bg-slate-50 text-slate-500' };
}

/**
 * Concise "rules this audit abides by" card for the finance audit rail:
 * rules version + tax year + freshness up front, official IRS sources with
 * authority badges and review dates behind a single expand.
 */
export default function FinanceAuditRulesCard({
  rules,
  loading = false,
  attachedRulesVersion,
}: FinanceAuditRulesCardProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);

  if (loading && !rules) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          <BookOpenCheck size={13} />
          IRS rules package
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-3 w-3/4 animate-pulse rounded bg-slate-100" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-slate-100" />
        </div>
      </div>
    );
  }

  if (!rules) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <div className="text-[11px] font-semibold uppercase tracking-wider">IRS rules package</div>
        <p className="mt-1.5 text-xs">
          Rules metadata could not be loaded for this view. Figures may still be computed correctly, but source
          traceability is unavailable until the rules package loads.
        </p>
      </div>
    );
  }

  const freshness = freshnessPill(rules.governance.freshnessStatus || rules.governance.stalenessStatus);
  const lastReviewed = fmtShortDate(rules.governance.lastReviewed);
  const warnings = [
    ...(rules.governance.warnings || []),
    ...(rules.governance.notes || []),
  ].filter(Boolean);
  const versionLabel = attachedRulesVersion || rules.rulesVersion;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="px-4 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            <BookOpenCheck size={13} />
            IRS rules package
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${freshness.cls}`}>
            {freshness.label}
          </span>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <span className="rounded-md bg-slate-900 px-2 py-0.5 font-mono text-[11px] font-semibold text-white">
            v{versionLabel}
          </span>
          <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700">
            Tax year {rules.taxYear}
          </span>
          <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium capitalize text-slate-700">
            {rules.approvalStatus}
          </span>
        </div>

        <p className="mt-2 text-[11px] text-slate-500">
          {lastReviewed ? `Sources last reviewed ${lastReviewed}.` : 'Source review date unavailable.'}
          {rules.origin === 'static-fallback' && ' Shown from the built-in rules package (live endpoint unavailable).'}
        </p>

        {warnings.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900">
            {warnings[0]}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={() => setSourcesOpen((value) => !value)}
        className="mt-3 flex w-full items-center justify-between border-t border-slate-100 px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-600 transition hover:bg-slate-50"
        aria-expanded={sourcesOpen}
      >
        <span>
          Official sources
          <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
            {rules.sources.length}
          </span>
        </span>
        <ChevronDown size={14} className={`transition-transform ${sourcesOpen ? 'rotate-180' : ''}`} />
      </button>

      {sourcesOpen && (
        <ul className="space-y-1.5 border-t border-slate-100 bg-slate-50/60 px-3 py-3">
          {rules.sources.map((source, index) => {
            const hostname = hostnameOf(source.url);
            const updated = fmtShortDate(source.lastUpdated);
            const body = (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 text-xs font-medium leading-snug text-slate-900">
                    {source.title}
                    {source.url && <ExternalLink size={11} className="ml-1 inline-block text-slate-400" />}
                  </div>
                  <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${
                    String(source.authority || '').toUpperCase() === 'IRS'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : 'border-slate-200 bg-white text-slate-600'
                  }`}>
                    {source.authority || 'Source'}
                  </span>
                </div>
                {source.appliesTo && (
                  <div className="mt-1 text-[11px] leading-snug text-slate-500">{source.appliesTo}</div>
                )}
                {(hostname || updated) && (
                  <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] font-medium text-slate-400">
                    {hostname && <span>{hostname}</span>}
                    {updated && <span>reviewed {updated}</span>}
                  </div>
                )}
              </>
            );

            return (
              <li key={source.id || `${source.title}-${index}`}>
                {source.url ? (
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded-lg border border-slate-200 bg-white px-3 py-2 transition hover:border-emerald-300 hover:shadow-sm"
                  >
                    {body}
                  </a>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
