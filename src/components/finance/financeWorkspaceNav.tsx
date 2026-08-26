/**
 * Shared navigation + organization primitives for the Bookkeeping and Tax
 * Center workspaces:
 *
 *  - WorkspaceSubTabs: sticky segmented sub-tab bar with per-tab accent colors
 *  - SectionHost: registered, scroll-targetable wrapper for major page
 *    sections (used by the AI assistant for "show me" navigation + highlight)
 *  - SectionGroupHeader: labelled divider band that delineates groups of
 *    cards inside a tab
 *  - GlossaryTip: plain-English jargon hints to flatten the learning curve
 *  - useWorkspaceNav: sub-tab state (persisted per page), section navigation,
 *    and the temporary highlight-pulse effect
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Accent system (modest, professional)
// ---------------------------------------------------------------------------

export type WorkspaceAccent = 'emerald' | 'sky' | 'amber' | 'violet' | 'indigo' | 'rose' | 'slate';

interface AccentClasses {
  /** Active sub-tab pill */
  tabActive: string;
  /** Inactive sub-tab hover hint */
  tabInactiveHover: string;
  /** Small dot / bar */
  bar: string;
  /** Section header label text */
  text: string;
  /** Highlight ring for AI navigation */
  ring: string;
  /** Soft tint band behind a section group header */
  band: string;
}

export const WORKSPACE_ACCENTS: Record<WorkspaceAccent, AccentClasses> = {
  emerald: {
    tabActive: 'border-emerald-300 bg-emerald-50 text-emerald-900',
    tabInactiveHover: 'hover:border-emerald-200 hover:text-emerald-800',
    bar: 'bg-emerald-500',
    text: 'text-emerald-800',
    ring: 'ring-emerald-400/80',
    band: 'from-emerald-50/80',
  },
  sky: {
    tabActive: 'border-sky-300 bg-sky-50 text-sky-900',
    tabInactiveHover: 'hover:border-sky-200 hover:text-sky-800',
    bar: 'bg-sky-500',
    text: 'text-sky-800',
    ring: 'ring-sky-400/80',
    band: 'from-sky-50/80',
  },
  amber: {
    tabActive: 'border-amber-300 bg-amber-50 text-amber-900',
    tabInactiveHover: 'hover:border-amber-200 hover:text-amber-800',
    bar: 'bg-amber-500',
    text: 'text-amber-800',
    ring: 'ring-amber-400/80',
    band: 'from-amber-50/80',
  },
  violet: {
    tabActive: 'border-violet-300 bg-violet-50 text-violet-900',
    tabInactiveHover: 'hover:border-violet-200 hover:text-violet-800',
    bar: 'bg-violet-500',
    text: 'text-violet-800',
    ring: 'ring-violet-400/80',
    band: 'from-violet-50/80',
  },
  indigo: {
    tabActive: 'border-indigo-300 bg-indigo-50 text-indigo-900',
    tabInactiveHover: 'hover:border-indigo-200 hover:text-indigo-800',
    bar: 'bg-indigo-500',
    text: 'text-indigo-800',
    ring: 'ring-indigo-400/80',
    band: 'from-indigo-50/80',
  },
  rose: {
    tabActive: 'border-rose-300 bg-rose-50 text-rose-900',
    tabInactiveHover: 'hover:border-rose-200 hover:text-rose-800',
    bar: 'bg-rose-500',
    text: 'text-rose-800',
    ring: 'ring-rose-400/80',
    band: 'from-rose-50/80',
  },
  slate: {
    tabActive: 'border-slate-400 bg-slate-100 text-slate-900',
    tabInactiveHover: 'hover:border-slate-300 hover:text-slate-800',
    bar: 'bg-slate-400',
    text: 'text-slate-700',
    ring: 'ring-slate-400/80',
    band: 'from-slate-100/80',
  },
};

// ---------------------------------------------------------------------------
// Tab + section definitions
// ---------------------------------------------------------------------------

export interface WorkspaceTabDef {
  id: string;
  label: string;
  shortLabel?: string;
  icon: LucideIcon;
  accent: WorkspaceAccent;
  description: string;
}

export interface WorkspaceSectionDef {
  id: string;
  tabId: string;
  title: string;
  /** One-line plain-English explanation, also used by the page tour. */
  description: string;
  /** Extra lowercase keywords for matching AI answers to this section. */
  keywords?: string[];
}

/**
 * Match free text (e.g. an AI answer) against registered sections so the
 * assistant can offer "Show me" navigation chips even when the backend does
 * not return explicit actions.
 */
export function matchSectionsInText(text: string, sections: WorkspaceSectionDef[], limit = 3): WorkspaceSectionDef[] {
  const lower = text.toLowerCase();
  const scored = sections
    .map((section) => {
      let score = 0;
      if (lower.includes(section.title.toLowerCase())) score += 3;
      for (const keyword of section.keywords || []) {
        if (keyword && lower.includes(keyword.toLowerCase())) score += 1;
      }
      return { section, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.section);
}

// ---------------------------------------------------------------------------
// useWorkspaceNav — sub-tab state + section navigation + highlight pulse
// ---------------------------------------------------------------------------

function readStoredTab(pageKey: string, tabs: WorkspaceTabDef[], fallback: string): string {
  try {
    const stored = window.sessionStorage.getItem(`finance-workspace-tab:${pageKey}`);
    if (stored && tabs.some((tab) => tab.id === stored)) return stored;
  } catch {
    // sessionStorage unavailable (SSR/private mode) — fall through
  }
  return fallback;
}

export interface WorkspaceNav {
  activeTab: string;
  setActiveTab: (tabId: string) => void;
  highlightedSectionId: string | null;
  /** Switch to the owning tab, smooth-scroll to the section, pulse-highlight it. */
  navigateToSection: (sectionId: string) => void;
  sections: WorkspaceSectionDef[];
  tabs: WorkspaceTabDef[];
}

export function useWorkspaceNav(
  pageKey: string,
  tabs: WorkspaceTabDef[],
  sections: WorkspaceSectionDef[],
): WorkspaceNav {
  const [activeTab, setActiveTabState] = useState<string>(() => readStoredTab(pageKey, tabs, tabs[0]?.id || ''));
  const [highlightedSectionId, setHighlightedSectionId] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setActiveTab = useCallback((tabId: string) => {
    setActiveTabState(tabId);
    try {
      window.sessionStorage.setItem(`finance-workspace-tab:${pageKey}`, tabId);
    } catch {
      // best-effort persistence only
    }
  }, [pageKey]);

  const navigateToSection = useCallback((sectionId: string) => {
    const section = sections.find((entry) => entry.id === sectionId);
    if (!section) return;
    setActiveTab(section.tabId);
    setHighlightedSectionId(sectionId);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedSectionId(null), 2600);
    // Let the tab switch render before scrolling to the (previously hidden) section.
    window.setTimeout(() => {
      const node = document.getElementById(`workspace-section-${sectionId}`);
      if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  }, [sections, setActiveTab]);

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  return { activeTab, setActiveTab, highlightedSectionId, navigateToSection, sections, tabs };
}

// ---------------------------------------------------------------------------
// WorkspaceSubTabs — sticky segmented control
// ---------------------------------------------------------------------------

export function WorkspaceSubTabs({ nav, embedded = false }: { nav: WorkspaceNav; embedded?: boolean }) {
  return (
    <div className={embedded ? '' : 'sticky top-2 z-30'}>
      <div className={`overflow-x-auto ${embedded ? '' : 'rounded-2xl border border-slate-200/90 bg-white/90 p-1.5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] backdrop-blur'}`}>
        <div className="flex min-w-max items-center gap-1.5" role="tablist" aria-label="Workspace sections">
          {nav.tabs.map((tab) => {
            const accent = WORKSPACE_ACCENTS[tab.accent];
            const active = nav.activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.description}
                onClick={() => nav.setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 whitespace-nowrap rounded-xl border px-3.5 py-2 text-sm font-semibold transition ${
                  active
                    ? `${accent.tabActive} shadow-sm`
                    : `border-transparent text-slate-600 hover:bg-slate-50 ${accent.tabInactiveHover}`
                }`}
              >
                <Icon size={15} className={active ? '' : 'text-slate-400'} />
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.shortLabel || tab.label}</span>
                {active && <span className={`h-1.5 w-1.5 rounded-full ${accent.bar}`} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionHost — scroll target + AI highlight pulse wrapper
// ---------------------------------------------------------------------------

export function SectionHost({
  sectionId,
  nav,
  className = '',
  children,
}: {
  sectionId: string;
  nav: WorkspaceNav;
  className?: string;
  children: React.ReactNode;
}) {
  const highlighted = nav.highlightedSectionId === sectionId;
  return (
    <div
      id={`workspace-section-${sectionId}`}
      className={`scroll-mt-24 rounded-2xl transition-all duration-700 ${
        highlighted ? 'ring-2 ring-offset-2 ring-offset-slate-50 ring-violet-400/90 shadow-[0_0_0_6px_rgba(139,92,246,0.12)]' : 'ring-0 ring-transparent'
      } ${className}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionGroupHeader — labelled divider band between card groups
// ---------------------------------------------------------------------------

export function SectionGroupHeader({
  title,
  hint,
  accent = 'slate',
  right,
}: {
  title: string;
  hint?: string;
  accent?: WorkspaceAccent;
  right?: React.ReactNode;
}) {
  const classes = WORKSPACE_ACCENTS[accent];
  return (
    <div className={`flex items-center gap-3 rounded-xl bg-gradient-to-r ${classes.band} to-transparent px-3 py-2`}>
      <span className={`h-4 w-1 shrink-0 rounded-full ${classes.bar}`} />
      <h3 className={`text-[11px] font-bold uppercase tracking-wider ${classes.text}`}>{title}</h3>
      {hint && <GlossaryTip term={title} explanation={hint} />}
      <div className="h-px flex-1 bg-slate-200/80" />
      {right && <div className="flex items-center gap-2 text-xs text-slate-500">{right}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GlossaryTip — plain-English jargon hints
// ---------------------------------------------------------------------------

/** Shared one-line plain-English explanations of finance/tax jargon. */
export const FINANCE_GLOSSARY: Record<string, string> = {
  'trial balance': 'A check that every debit posted to the books has a matching credit — if it balances, the ledger math is internally consistent.',
  'tie-out': 'Confirming that two reports of the same money agree line by line (e.g. the ledger total matches the Schedule E total).',
  'safe harbor': 'IRS thresholds (90% of this year or 100%/110% of last year) — pay at least that much during the year and you avoid an underpayment penalty.',
  '§280a': 'IRS rule for mixed personal/rental use of a home: expenses must be split so only the rental share is deducted.',
  'qbi': 'Qualified Business Income — a potential ~20% deduction on rental profits when the activity counts as a business (Form 8995).',
  'packet release': 'A frozen, uneditable snapshot of your tax workpapers handed to a CPA — like sealing the envelope so figures cannot silently change.',
  'reconciliation': 'Matching what the bank says happened against what your books say happened, and explaining any differences.',
  'close period': 'Locking a month so its numbers stop changing — anything new must post to a later, open month.',
  'schedule e': 'The IRS form where rental income and expenses are reported on your personal tax return.',
  '1040-es': 'The IRS voucher used to send quarterly estimated tax payments during the year.',
  'workpapers': 'The supporting schedules and evidence behind each tax-return number, organized for CPA review.',
  '1099-nec': 'The form you must send contractors paid over the IRS threshold during the year.',
  'w-2 bridge': 'Feeding wages and withholding from uploaded W-2s into the tax estimate, instead of typing them manually.',
  'depreciation': 'Deducting the building cost gradually over 27.5 years instead of all at once. Land never depreciates.',
  'evidence': 'Receipts, statements, and documents linked to ledger entries proving each number is real.',
  'noi': 'Net Operating Income — rental income minus operating expenses, before debt service and taxes.',
  'chart of accounts': 'The standardized list of buckets (accounts) every transaction is filed under.',
  'ledger': 'The master record of every posted transaction — the single source of truth for all reports.',
};

export function GlossaryTip({ term, explanation }: { term: string; explanation?: string }) {
  const text = explanation || FINANCE_GLOSSARY[term.toLowerCase()] || '';
  if (!text) return null;
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`What does ${term} mean?`}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-400 transition hover:text-violet-600 focus:text-violet-600 focus:outline-none"
        tabIndex={0}
      >
        <HelpCircle size={13} />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute left-1/2 top-full z-40 mt-1.5 w-64 -translate-x-1/2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-[11px] font-normal normal-case leading-relaxed tracking-normal text-slate-700 opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        <span className="block font-semibold text-slate-900">{term}</span>
        {text}
      </span>
    </span>
  );
}
