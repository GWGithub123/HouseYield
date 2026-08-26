import React, { useState } from 'react';
import { ChevronDown, ShieldCheck, Sparkles } from 'lucide-react';
import FinanceAuditRulesCard from './FinanceAuditRulesCard';
import FinanceAuditAskBox from './FinanceAuditAskBox';
import type { FinanceAuditRulesSources, FinanceAuditSurface } from '../../services/financeAuditClient';

export type FinanceAuditTone = 'slate' | 'emerald' | 'amber' | 'rose';

export interface FinanceAuditMetric {
  label: string;
  value: string;
  hint?: string;
}

export interface FinanceAuditFlag {
  title: string;
  detail: string;
  tone?: FinanceAuditTone;
}

export interface FinanceAuditSectionItem {
  title: string;
  detail?: string;
  meta?: string;
  tone?: FinanceAuditTone;
  href?: string;
}

export interface FinanceAuditSection {
  label: string;
  summary?: string;
  items: Array<string | FinanceAuditSectionItem>;
  tone?: FinanceAuditTone;
  emptyText?: string;
  /** Open the section by default instead of starting collapsed. */
  defaultOpen?: boolean;
}

export interface FinanceAuditAskConfig {
  surface: FinanceAuditSurface;
  getContext: () => Record<string, unknown>;
  suggestions?: string[];
}

interface FinanceAuditRailProps {
  title: string;
  subtitle: string;
  disclaimer: string;
  statusLabel: string;
  statusTone?: FinanceAuditTone;
  statusDetail?: string;
  statusMeta?: string[];
  metrics?: FinanceAuditMetric[];
  flags?: FinanceAuditFlag[];
  sections?: FinanceAuditSection[];
  /** Structured IRS rules package display (tax surface). */
  rules?: FinanceAuditRulesSources | null;
  rulesLoading?: boolean;
  /** Rules version attached to the persisted snapshot, if any. */
  attachedRulesVersion?: string | null;
  /** Enables the chat-style ask-the-audit box. */
  ask?: FinanceAuditAskConfig;
}

function toneClass(tone: FinanceAuditTone = 'slate') {
  switch (tone) {
    case 'emerald':
      return 'border-emerald-200 bg-emerald-50 text-emerald-950';
    case 'amber':
      return 'border-amber-200 bg-amber-50 text-amber-950';
    case 'rose':
      return 'border-rose-200 bg-rose-50 text-rose-950';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-900';
  }
}

function statusDotClass(tone: FinanceAuditTone = 'slate') {
  switch (tone) {
    case 'emerald':
      return 'bg-emerald-500';
    case 'amber':
      return 'bg-amber-500';
    case 'rose':
      return 'bg-rose-500';
    default:
      return 'bg-slate-400';
  }
}

function flagAccentClass(tone: FinanceAuditTone = 'amber') {
  switch (tone) {
    case 'emerald':
      return 'border-l-emerald-400';
    case 'rose':
      return 'border-l-rose-400';
    case 'slate':
      return 'border-l-slate-300';
    default:
      return 'border-l-amber-400';
  }
}

function sectionToneDot(tone?: FinanceAuditTone) {
  switch (tone) {
    case 'emerald':
      return 'bg-emerald-500';
    case 'amber':
      return 'bg-amber-500';
    case 'rose':
      return 'bg-rose-500';
    default:
      return 'bg-slate-300';
  }
}

function normalizeSectionItem(item: string | FinanceAuditSectionItem): FinanceAuditSectionItem {
  if (typeof item === 'string') {
    return { title: item };
  }

  return item;
}

function CollapsibleSection({ section }: { section: FinanceAuditSection }) {
  const [open, setOpen] = useState(Boolean(section.defaultOpen));

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition hover:bg-slate-50"
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sectionToneDot(section.tone)}`} />
          <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-slate-600">
            {section.label}
          </span>
          <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
            {section.items.length}
          </span>
        </span>
        <ChevronDown size={14} className={`shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="border-t border-slate-100">
          {section.summary && (
            <p className="px-4 pb-1 pt-3 text-xs leading-relaxed text-slate-500">{section.summary}</p>
          )}
          {section.items.length > 0 ? (
            <ul className="space-y-1.5 px-3 py-3">
              {section.items.map((item, index) => {
                const normalized = normalizeSectionItem(item);
                return (
                  <li
                    key={`${section.label}-${normalized.title}-${index}`}
                    className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2"
                  >
                    <div className="text-xs font-medium leading-snug text-slate-900">
                      {normalized.href ? (
                        <a
                          href={normalized.href}
                          target="_blank"
                          rel="noreferrer"
                          className="underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                        >
                          {normalized.title}
                        </a>
                      ) : (
                        normalized.title
                      )}
                    </div>
                    {normalized.detail && (
                      <div className="mt-1 text-[11px] leading-relaxed text-slate-600">{normalized.detail}</div>
                    )}
                    {normalized.meta && (
                      <div className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        {normalized.meta}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="px-4 py-3 text-xs text-slate-500">
              {section.emptyText || 'No audit details are available for this section yet.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FinanceAuditRail({
  title,
  subtitle,
  disclaimer,
  statusLabel,
  statusTone = 'slate',
  statusDetail,
  statusMeta = [],
  metrics = [],
  flags = [],
  sections = [],
  rules,
  rulesLoading = false,
  attachedRulesVersion,
  ask,
}: FinanceAuditRailProps) {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <aside className="xl:sticky xl:top-4 xl:self-start">
      <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto xl:overscroll-y-contain">
        {/* Header */}
        <div className="px-1 pt-1">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
              <Sparkles size={12} />
              Audit
            </div>
            <button
              type="button"
              onClick={() => setDetailOpen((value) => !value)}
              className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 transition hover:text-slate-600"
            >
              {detailOpen ? 'Hide info' : 'About'}
            </button>
          </div>
          <h3 className="mt-2 text-sm font-semibold text-slate-900">{title}</h3>
          {detailOpen && (
            <div className="mt-1.5 space-y-1.5">
              <p className="text-xs leading-relaxed text-slate-500">{subtitle}</p>
              <p className="text-[10px] leading-relaxed text-slate-400">{disclaimer}</p>
            </div>
          )}
        </div>

        {/* Status */}
        <div className={`rounded-xl border p-3.5 ${toneClass(statusTone)}`}>
          <div className="flex items-start gap-2">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${statusDotClass(statusTone)}`} />
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-snug">{statusLabel}</div>
              {statusDetail && <p className="mt-1 text-xs leading-relaxed opacity-80">{statusDetail}</p>}
            </div>
          </div>
          {statusMeta.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {statusMeta.map((item) => (
                <span key={item} className="rounded-full border border-current/10 bg-white/70 px-2 py-0.5 text-[10px] font-medium">
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Rules package */}
        {(rules || rulesLoading) && (
          <FinanceAuditRulesCard
            rules={rules || null}
            loading={rulesLoading}
            attachedRulesVersion={attachedRulesVersion}
          />
        )}

        {/* Metrics */}
        {metrics.length > 0 && (
          <div className="grid grid-cols-2 gap-1.5">
            {metrics.map((metric) => (
              <div key={metric.label} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{metric.label}</div>
                <div className="mt-0.5 truncate text-base font-semibold tabular-nums text-slate-900">{metric.value}</div>
                {metric.hint && <div className="mt-0.5 truncate text-[10px] text-slate-500" title={metric.hint}>{metric.hint}</div>}
              </div>
            ))}
          </div>
        )}

        {/* Flags */}
        {flags.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              <ShieldCheck size={12} />
              Priority flags
            </div>
            {flags.map((flag) => (
              <div
                key={`${flag.title}-${flag.detail}`}
                className={`rounded-lg border border-slate-200 border-l-2 bg-white px-3 py-2 ${flagAccentClass(flag.tone || 'amber')}`}
              >
                <div className="text-xs font-semibold text-slate-900">{flag.title}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-slate-600">{flag.detail}</div>
              </div>
            ))}
          </div>
        )}

        {/* Ask the audit */}
        {ask && (
          <FinanceAuditAskBox surface={ask.surface} getContext={ask.getContext} suggestions={ask.suggestions} />
        )}

        {/* Detail sections (collapsed by default) */}
        {sections.length > 0 && (
          <div className="space-y-1.5">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Detail</div>
            {sections.map((section) => (
              <CollapsibleSection key={section.label} section={section} />
            ))}
          </div>
        )}

        {!detailOpen && (
          <p className="px-1 pb-1 text-[10px] leading-relaxed text-slate-400">{disclaimer}</p>
        )}
      </div>
    </aside>
  );
}
