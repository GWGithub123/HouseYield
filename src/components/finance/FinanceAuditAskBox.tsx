import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, MessageCircleQuestion, Send } from 'lucide-react';
import {
  askFinanceAudit,
  FinanceAuditAskError,
  type FinanceAuditAnswer,
  type FinanceAuditSurface,
} from '../../services/financeAuditClient';

interface AskExchange {
  id: string;
  question: string;
  status: 'loading' | 'answered' | 'error';
  answer?: FinanceAuditAnswer;
  errorMessage?: string;
  errorCode?: string;
}

interface FinanceAuditAskBoxProps {
  surface: FinanceAuditSurface;
  /** Audit snapshot context forwarded to the assistant with every question. */
  getContext: () => Record<string, unknown>;
  suggestions?: string[];
}

function hostnameOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function confidencePill(confidence?: string) {
  if (confidence === 'high') return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (confidence === 'low') return 'border-rose-200 bg-rose-50 text-rose-700';
  return 'border-amber-200 bg-amber-50 text-amber-700';
}

/**
 * Chat-style "ask the audit" box for the finance audit rail. Wired to
 * POST /api/finance-audit/ask with the page's audit snapshot as context.
 */
export default function FinanceAuditAskBox({ surface, getContext, suggestions = [] }: FinanceAuditAskBoxProps) {
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<AskExchange[]>([]);
  const [pending, setPending] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [exchanges]);

  async function submitQuestion(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || pending) return;

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setExchanges((current) => [...current, { id, question: trimmed, status: 'loading' }]);
    setQuestion('');
    setPending(true);

    try {
      const answer = await askFinanceAudit({ surface, question: trimmed, context: getContext() });
      setExchanges((current) => current.map((exchange) => (
        exchange.id === id ? { ...exchange, status: 'answered', answer } : exchange
      )));
    } catch (error) {
      const message = error instanceof FinanceAuditAskError
        ? error.message
        : 'Something went wrong while answering. Please try again.';
      const code = error instanceof FinanceAuditAskError ? error.code : undefined;
      setExchanges((current) => current.map((exchange) => (
        exchange.id === id ? { ...exchange, status: 'error', errorMessage: message, errorCode: code } : exchange
      )));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
        <MessageCircleQuestion size={13} />
        Ask the audit
      </div>

      {exchanges.length === 0 && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => submitQuestion(suggestion)}
              disabled={pending}
              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600 transition hover:border-slate-300 hover:bg-white hover:text-slate-900 disabled:opacity-50"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {exchanges.length > 0 && (
        <div ref={threadRef} className="max-h-96 space-y-3 overflow-y-auto px-4 py-3">
          {exchanges.map((exchange) => (
            <div key={exchange.id} className="space-y-2">
              <div className="flex justify-end">
                <div className="max-w-[90%] rounded-2xl rounded-br-md bg-slate-900 px-3 py-2 text-xs leading-relaxed text-white">
                  {exchange.question}
                </div>
              </div>

              {exchange.status === 'loading' && (
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  <Loader2 size={13} className="animate-spin" />
                  Checking your audit data and IRS sources…
                </div>
              )}

              {exchange.status === 'error' && (
                <div className="flex items-start gap-2 rounded-2xl rounded-bl-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-900">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span>{exchange.errorMessage}</span>
                </div>
              )}

              {exchange.status === 'answered' && exchange.answer && (
                <div className="space-y-2 rounded-2xl rounded-bl-md border border-slate-200 bg-slate-50 px-3 py-2.5">
                  <p className="text-xs leading-relaxed text-slate-800">{exchange.answer.answer}</p>

                  {exchange.answer.bullets.length > 0 && (
                    <ul className="space-y-1">
                      {exchange.answer.bullets.map((bullet, index) => (
                        <li key={`${exchange.id}-bullet-${index}`} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-600">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-emerald-500" />
                          {bullet}
                        </li>
                      ))}
                    </ul>
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
                            {source.authority && (
                              <span className="font-bold uppercase tracking-wider">{source.authority}</span>
                            )}
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

                  <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-200/70 pt-1.5">
                    {exchange.answer.confidence && (
                      <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${confidencePill(exchange.answer.confidence)}`}>
                        {exchange.answer.confidence} confidence
                      </span>
                    )}
                    {exchange.answer.rulesVersion && (
                      <span className="rounded-full border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[9px] font-semibold text-slate-500">
                        rules v{exchange.answer.rulesVersion}
                      </span>
                    )}
                    {exchange.answer.taxYear != null && (
                      <span className="rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
                        TY {exchange.answer.taxYear}
                      </span>
                    )}
                  </div>

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
        className="flex items-center gap-2 border-t border-slate-100 px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          submitQuestion(question);
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={surface === 'tax' ? 'e.g. Why is my net due this amount?' : 'e.g. Why are there open exceptions?'}
          maxLength={2000}
          className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending || !question.trim()}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white transition hover:bg-slate-700 disabled:opacity-40"
          aria-label="Ask"
        >
          {pending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
        </button>
      </form>
    </div>
  );
}
