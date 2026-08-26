/**
 * FinanceAssistantHeader
 *
 * Persistent slim AI assistant bar for the Bookkeeping and Tax Center pages.
 *
 *  - Shows a one-line summary of the current page state (deterministic local
 *    summary immediately; refined once by the AI backend when available)
 *  - "Ask anything" input that expands into a chat panel backed by
 *    POST /api/finance-audit/ask (same backend as the audit rail ask box)
 *  - Answers can navigate: backend-returned scrollTo actions and client-side
 *    keyword matches render "Show me" chips that switch sub-tab, smooth-scroll
 *    to the section, and pulse-highlight it
 *  - "Tour this page" walks through every registered section with highlights
 *    and plain-English descriptions
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  Compass,
  CornerDownRight,
  ExternalLink,
  Loader2,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import {
  askFinanceAudit,
  fetchFinanceAuditSummary,
  FinanceAuditAskError,
  type FinanceAuditAnswer,
  type FinanceAuditSurface,
} from '../../services/financeAuditClient';
import {
  matchSectionsInText,
  WORKSPACE_ACCENTS,
  type WorkspaceNav,
  type WorkspaceSectionDef,
} from './financeWorkspaceNav';

interface AssistantExchange {
  id: string;
  question: string;
  status: 'loading' | 'answered' | 'error';
  answer?: FinanceAuditAnswer;
  /** Sections the user can jump to for this answer. */
  navTargets?: WorkspaceSectionDef[];
  errorMessage?: string;
}

interface FinanceAssistantHeaderProps {
  surface: FinanceAuditSurface;
  /** Deterministic one-line summary built from live page data (instant). */
  localSummary: string;
  /** Page context snapshot forwarded with summary + ask calls. */
  getContext: () => Record<string, unknown>;
  nav: WorkspaceNav;
  suggestions?: string[];
  /** Changes (e.g. data loaded) re-trigger the one-time AI summary fetch. */
  summaryRefreshKey?: string | number;
  embedded?: boolean;
}

function hostnameOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export default function FinanceAssistantHeader({
  surface,
  localSummary,
  getContext,
  nav,
  suggestions = [],
  summaryRefreshKey,
  embedded = false,
}: FinanceAssistantHeaderProps) {
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [summaryPending, setSummaryPending] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<AssistantExchange[]>([]);
  const [pending, setPending] = useState(false);
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const summaryRequestedFor = useRef<string | number | undefined>(undefined);

  const sectionRefs = useMemo(
    () => nav.sections.map((section) => ({ id: section.id, title: section.title, description: section.description })),
    [nav.sections],
  );

  // One AI summary fetch per refresh key (typically once data has loaded).
  useEffect(() => {
    if (summaryRefreshKey == null || summaryRequestedFor.current === summaryRefreshKey) return;
    summaryRequestedFor.current = summaryRefreshKey;
    let cancelled = false;
    setSummaryPending(true);
    fetchFinanceAuditSummary({ surface, context: getContext() })
      .then((summary) => {
        if (!cancelled && summary) setAiSummary(summary);
      })
      .finally(() => {
        if (!cancelled) setSummaryPending(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryRefreshKey, surface]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [exchanges, chatOpen]);

  async function submitQuestion(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || pending) return;
    setChatOpen(true);

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setExchanges((current) => [...current, { id, question: trimmed, status: 'loading' }]);
    setQuestion('');
    setPending(true);

    try {
      const answer = await askFinanceAudit({
        surface,
        question: trimmed,
        context: getContext(),
        sections: sectionRefs,
      });
      // Prefer explicit backend actions; fall back to client-side keyword
      // matching of the answer text against registered sections.
      const actionTargets = answer.actions
        .map((action) => nav.sections.find((section) => section.id === action.sectionId))
        .filter((section): section is WorkspaceSectionDef => Boolean(section));
      const navTargets = actionTargets.length > 0
        ? actionTargets
        : matchSectionsInText(`${answer.answer} ${answer.bullets.join(' ')} ${trimmed}`, nav.sections, 2);
      setExchanges((current) => current.map((exchange) => (
        exchange.id === id ? { ...exchange, status: 'answered', answer, navTargets } : exchange
      )));
    } catch (error) {
      const message = error instanceof FinanceAuditAskError
        ? error.message
        : 'Something went wrong while answering. Please try again.';
      setExchanges((current) => current.map((exchange) => (
        exchange.id === id ? { ...exchange, status: 'error', errorMessage: message } : exchange
      )));
    } finally {
      setPending(false);
    }
  }

  // ---- Tour ----
  const tourSection = tourIndex != null ? nav.sections[tourIndex] : null;
  const tourTab = tourSection ? nav.tabs.find((tab) => tab.id === tourSection.tabId) : null;

  function startTour() {
    if (nav.sections.length === 0) return;
    setTourIndex(0);
    nav.navigateToSection(nav.sections[0].id);
  }

  function stepTour(delta: number) {
    if (tourIndex == null) return;
    const next = tourIndex + delta;
    if (next < 0 || next >= nav.sections.length) {
      setTourIndex(null);
      return;
    }
    setTourIndex(next);
    nav.navigateToSection(nav.sections[next].id);
  }

  const summaryText = aiSummary || localSummary;

  return (
    <>
      <div className={embedded
        ? 'overflow-hidden bg-gradient-to-r from-violet-50/90 via-white to-sky-50/60'
        : 'overflow-hidden rounded-2xl border border-violet-200/70 bg-gradient-to-r from-violet-50/90 via-white to-sky-50/60 shadow-[0_1px_3px_rgba(15,23,42,0.06)]'}
      >
        {/* Slim summary bar */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-violet-200 bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-violet-700">
            <Sparkles size={12} />
            AI guide
          </span>
          <p className="min-w-0 flex-1 truncate text-sm text-slate-700" title={summaryText}>
            {summaryPending && !aiSummary ? (
              <span className="inline-flex items-center gap-1.5 text-slate-500">
                <Loader2 size={12} className="animate-spin" />
                {localSummary}
              </span>
            ) : (
              summaryText
            )}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={startTour}
              disabled={nav.sections.length === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-violet-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-violet-800 transition hover:bg-violet-50 disabled:opacity-50"
            >
              <Compass size={13} />
              Tour this page
            </button>
            <button
              type="button"
              onClick={() => setChatOpen((value) => !value)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
                chatOpen
                  ? 'border-violet-400 bg-violet-600 text-white hover:bg-violet-500'
                  : 'border-violet-200 bg-white text-violet-800 hover:bg-violet-50'
              }`}
              aria-expanded={chatOpen}
            >
              {chatOpen ? <ChevronDown size={13} /> : <Send size={12} />}
              {chatOpen ? 'Hide chat' : 'Ask anything'}
            </button>
          </div>
        </div>

        {/* Expanding chat panel */}
        {chatOpen && (
          <div className="border-t border-violet-100 bg-white/80">
            {exchanges.length === 0 && (
              <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Try</span>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => submitQuestion(suggestion)}
                    disabled={pending}
                    className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 transition hover:border-violet-300 hover:bg-white hover:text-violet-800 disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}

            {exchanges.length > 0 && (
              <div ref={threadRef} className="max-h-[26rem] space-y-3 overflow-y-auto px-4 py-3">
                {exchanges.map((exchange) => (
                  <div key={exchange.id} className="space-y-2">
                    <div className="flex justify-end">
                      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-900 px-3 py-2 text-xs leading-relaxed text-white">
                        {exchange.question}
                      </div>
                    </div>

                    {exchange.status === 'loading' && (
                      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                        <Loader2 size={13} className="animate-spin" />
                        Checking your numbers and IRS sources…
                      </div>
                    )}

                    {exchange.status === 'error' && (
                      <div className="flex items-start gap-2 rounded-2xl rounded-bl-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-900">
                        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                        <span>{exchange.errorMessage}</span>
                      </div>
                    )}

                    {exchange.status === 'answered' && exchange.answer && (
                      <div className="max-w-[95%] space-y-2 rounded-2xl rounded-bl-md border border-slate-200 bg-slate-50 px-3 py-2.5">
                        <p className="text-xs leading-relaxed text-slate-800">{exchange.answer.answer}</p>

                        {exchange.answer.bullets.length > 0 && (
                          <ul className="space-y-1">
                            {exchange.answer.bullets.map((bullet, index) => (
                              <li key={`${exchange.id}-bullet-${index}`} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-600">
                                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-violet-500" />
                                {bullet}
                              </li>
                            ))}
                          </ul>
                        )}

                        {(exchange.navTargets || []).length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-violet-600">
                              <CornerDownRight size={11} />
                              Show me
                            </span>
                            {(exchange.navTargets || []).map((target) => {
                              const tab = nav.tabs.find((entry) => entry.id === target.tabId);
                              const accent = WORKSPACE_ACCENTS[tab?.accent || 'violet'];
                              return (
                                <button
                                  key={`${exchange.id}-nav-${target.id}`}
                                  type="button"
                                  onClick={() => nav.navigateToSection(target.id)}
                                  title={target.description}
                                  className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-violet-800 transition hover:bg-violet-50"
                                >
                                  <span className={`h-1.5 w-1.5 rounded-full ${accent.bar}`} />
                                  {target.title}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {exchange.answer.sources.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {exchange.answer.sources.map((source, index) => {
                              const hostname = hostnameOf(source.url);
                              const label = hostname || source.authority || source.title;
                              return source.url ? (
                                <a
                                  key={`${exchange.id}-src-${index}`}
                                  href={source.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  title={source.title}
                                  className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 transition hover:bg-emerald-100"
                                >
                                  {source.authority && <span className="font-bold uppercase tracking-wider">{source.authority}</span>}
                                  {label}
                                  <ExternalLink size={9} />
                                </a>
                              ) : (
                                <span
                                  key={`${exchange.id}-src-${index}`}
                                  title={source.title}
                                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600"
                                >
                                  {label}
                                </span>
                              );
                            })}
                          </div>
                        )}

                        {(exchange.answer.dataUsed || []).length > 0 && (
                          <p className="border-t border-slate-200/70 pt-1.5 text-[10px] leading-relaxed text-slate-400">
                            <span className="font-semibold text-slate-500">Checked canonical ledger:</span>{' '}
                            {(exchange.answer.dataUsed || []).join(' · ')}
                          </p>
                        )}

                        {exchange.answer.disclaimer && (
                          <p className="text-[10px] leading-relaxed text-slate-400">{exchange.answer.disclaimer}</p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <form
              className="flex items-center gap-2 border-t border-violet-100/80 px-3 py-2.5"
              onSubmit={(event) => {
                event.preventDefault();
                submitQuestion(question);
              }}
            >
              <input
                type="text"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={surface === 'tax'
                  ? 'Ask about your taxes — e.g. "What is safe harbor and am I covered?"'
                  : 'Ask about your books — e.g. "What do I still need to do before closing this month?"'}
                maxLength={2000}
                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-violet-400 focus:bg-white focus:outline-none"
              />
              <button
                type="submit"
                disabled={pending || !question.trim()}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-white transition hover:bg-violet-500 disabled:opacity-40"
                aria-label="Ask"
              >
                {pending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            </form>
          </div>
        )}
      </div>

      {/* Tour overlay card */}
      {tourSection && (
        <div className="fixed bottom-4 right-4 z-50 w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-violet-200 bg-white p-4 shadow-[0_16px_48px_rgba(76,29,149,0.18)]">
          <div className="flex items-start justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-violet-700">
              <Compass size={12} />
              Page tour · {(tourIndex ?? 0) + 1} of {nav.sections.length}
            </div>
            <button
              type="button"
              onClick={() => setTourIndex(null)}
              className="rounded-md p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              aria-label="End tour"
            >
              <X size={14} />
            </button>
          </div>
          {tourTab && (
            <div className="mt-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {tourTab.label} tab
            </div>
          )}
          <div className="mt-0.5 text-sm font-semibold text-slate-900">{tourSection.title}</div>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">{tourSection.description}</p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => stepTour(-1)}
              disabled={(tourIndex ?? 0) === 0}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
            >
              Back
            </button>
            <div className="flex items-center gap-1">
              {nav.sections.map((section, index) => (
                <span
                  key={section.id}
                  className={`h-1.5 rounded-full transition-all ${index === tourIndex ? 'w-4 bg-violet-500' : 'w-1.5 bg-slate-200'}`}
                />
              ))}
            </div>
            {(tourIndex ?? 0) < nav.sections.length - 1 ? (
              <button
                type="button"
                onClick={() => stepTour(1)}
                className="rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-500"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setTourIndex(null)}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500"
              >
                Done
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
