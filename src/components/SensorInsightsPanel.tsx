/**
 * SensorInsightsPanel — the analysis side rail for the Predictive
 * Maintenance Analytics tab.
 *
 * The opening summary is deterministic and built directly from the analytics
 * snapshot so it is always readable, complete, and stable. Follow-up
 * questions still go through the AI assistant.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, Sparkles, X } from 'lucide-react';
import { askSensorInsights, type SensorInsightsAnswer, type SensorInsightsTurn } from '../services/sensorInsightsClient';

interface Exchange {
  id: number;
  question: string;
  status: 'pending' | 'done' | 'error';
  answer?: SensorInsightsAnswer;
  errorMessage?: string;
}

const SUGGESTIONS = [
  'Which room needs attention first?',
  'How does the local weather change the risk picture?',
  'What does the freeze layer change about the risk picture?',
  'Which insulation issue would you fix first?',
  'Is the humidity pattern normal for this time of year?',
];

function buildOverviewFromContext(context: Record<string, unknown>): SensorInsightsAnswer {
  const assessments = ((context as any).assessments || {}) as Record<string, any>;
  const mold = assessments.mold || null;
  const freeze = assessments.freeze || null;
  const insulation = assessments.insulation || null;
  const outsideWeather = (context as any).outsideWeather;
  const activePropertyAddress = typeof (context as any).activePropertyAddress === 'string'
    ? (context as any).activePropertyAddress
    : null;

  const levels = [mold?.level, freeze?.level, insulation?.level];
  const hasHigh = levels.includes('high');
  const hasWatch = levels.includes('watch');

  const answer = hasHigh
    ? `The main concerns right now are humidity and room-balance issues${activePropertyAddress ? ` at ${activePropertyAddress}` : ''}.`
    : hasWatch
      ? `There are a couple of early warning signs worth watching${activePropertyAddress ? ` at ${activePropertyAddress}` : ''}, but nothing looks immediately critical.`
      : `The home looks broadly stable right now${activePropertyAddress ? ` at ${activePropertyAddress}` : ''}, with no obvious urgent environmental issue.`;

  const bullets: string[] = [];

  if (mold) {
    bullets.push(`Mold: ${mold.headline}${mold.level !== 'low' && mold.recommendedAction ? ` ${mold.recommendedAction}` : ''}`);
  }
  if (freeze) {
    bullets.push(`Freeze: ${freeze.headline}${freeze.level !== 'low' && freeze.recommendedAction ? ` ${freeze.recommendedAction}` : ''}`);
  }
  if (insulation) {
    bullets.push(`Insulation: ${insulation.headline}${insulation.level !== 'low' && insulation.recommendedAction ? ` ${insulation.recommendedAction}` : ''}`);
  }

  if (outsideWeather && typeof outsideWeather === 'object' && typeof outsideWeather.tempF === 'number') {
    const tempF = Number(outsideWeather.tempF);
    const description = typeof outsideWeather.description === 'string' ? outsideWeather.description : 'current conditions';
    const weatherRead = tempF <= 38
      ? `Weather: It is about ${Math.round(tempF)}°F outside (${description}), which makes freeze risk more important than usual.`
      : tempF <= 50
        ? `Weather: It is about ${Math.round(tempF)}°F outside (${description}), so indoor cold spots matter if the house loses heat overnight.`
        : `Weather: It is about ${Math.round(tempF)}°F outside (${description}), so current risk is more about indoor humidity and room imbalance than outdoor cold.`;
    bullets.push(weatherRead);
  } else if (typeof outsideWeather === 'string' && outsideWeather.includes('unavailable')) {
    bullets.push('Weather: Outdoor conditions are not included yet because this property is missing location data.');
  }

  return {
    answer,
    bullets: bullets.slice(0, 4),
    confidence: 'high',
  };
}

export default function SensorInsightsPanel({
  context,
  onClose,
}: {
  /** Snapshot of the analytics the user is currently looking at. */
  context: Record<string, unknown>;
  onClose: () => void;
}) {
  const [overview, setOverview] = useState<SensorInsightsAnswer | null>(null);
  const [overviewStatus, setOverviewStatus] = useState<'loading' | 'done'>('loading');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;

  // Build a stable opening summary directly from the analytics snapshot.
  useEffect(() => {
    setOverviewStatus('loading');
    setOverview(buildOverviewFromContext(contextRef.current));
    setOverviewStatus('done');
  }, [context]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [exchanges, overviewStatus]);

  const submitQuestion = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    const id = Date.now();
    setExchanges((prev) => [...prev, { id, question: trimmed, status: 'pending' }]);
    setQuestion('');
    setPending(true);

    const history: SensorInsightsTurn[] = [];
    if (overview) {
      history.push({ role: 'assistant', text: [overview.answer, ...overview.bullets].join(' ') });
    }
    exchanges.forEach((exchange) => {
      history.push({ role: 'user', text: exchange.question });
      if (exchange.answer) {
        history.push({ role: 'assistant', text: [exchange.answer.answer, ...exchange.answer.bullets].join(' ') });
      }
    });

    try {
      const answer = await askSensorInsights({ mode: 'qa', question: trimmed, context: contextRef.current, history });
      setExchanges((prev) => prev.map((e) => (e.id === id ? { ...e, status: 'done', answer } : e)));
    } catch (error) {
      setExchanges((prev) => prev.map((e) => (
        e.id === id
          ? { ...e, status: 'error', errorMessage: error instanceof Error ? error.message : 'Request failed.' }
          : e
      )));
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="flex max-h-[min(720px,80vh)] flex-col rounded-2xl border border-violet-200 bg-white shadow-sm xl:sticky xl:top-4 xl:self-start">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet-100 text-violet-600">
            <Sparkles size={14} />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">AI analysis</h3>
            <p className="text-[11px] text-slate-500">Reads the data you're looking at right now</p>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close AI analysis"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
        >
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {/* Overview analysis */}
        {overviewStatus === 'loading' && (
          <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-3 text-xs text-slate-500">
            <Loader2 size={14} className="animate-spin" />
            Summarizing the current snapshot…
          </div>
        )}
        {overviewStatus === 'done' && overview && (
          <div className="rounded-xl bg-violet-50/70 px-3 py-3">
            <p className="text-sm leading-relaxed text-slate-800">{overview.answer}</p>
            {overview.bullets.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {overview.bullets.map((bullet, index) => (
                  <li key={index} className="flex items-start gap-2 text-xs leading-relaxed text-slate-600">
                    <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-violet-400" />
                    <span>
                      {/^Mold:|^Freeze:|^Insulation:/i.test(bullet) ? (
                        <>
                          <span className="font-semibold text-slate-700">{bullet.split(':')[0]}:</span>
                          {' '}
                          {bullet.slice(bullet.indexOf(':') + 1).trim()}
                        </>
                      ) : bullet}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Suggestion chips before the first question */}
        {exchanges.length === 0 && overviewStatus === 'done' && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submitQuestion(suggestion)}
                className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 transition hover:border-violet-200 hover:text-violet-700"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {/* Follow-up thread */}
        {exchanges.map((exchange) => (
          <div key={exchange.id} className="space-y-2">
            <div className="ml-6 rounded-xl rounded-br-sm bg-slate-900 px-3 py-2 text-xs leading-relaxed text-white">
              {exchange.question}
            </div>
            {exchange.status === 'pending' && (
              <div className="mr-6 flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
                <Loader2 size={13} className="animate-spin" />
                Thinking…
              </div>
            )}
            {exchange.status === 'error' && (
              <div className="mr-6 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {exchange.errorMessage}
              </div>
            )}
            {exchange.status === 'done' && exchange.answer && (
              <div className="mr-6 rounded-xl rounded-bl-sm bg-slate-50 px-3 py-2.5">
                <p className="text-xs leading-relaxed text-slate-700">{exchange.answer.answer}</p>
                {exchange.answer.bullets.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {exchange.answer.bullets.map((bullet, index) => (
                      <li key={index} className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-600">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-slate-400" />
                        {bullet}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}
        <div ref={threadEndRef} />
      </div>

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
          placeholder="Ask a follow-up…"
          className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 placeholder:text-slate-400 focus:border-violet-300 focus:outline-none"
        />
        <button
          type="submit"
          disabled={pending || !question.trim()}
          aria-label="Send question"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-violet-600 text-white transition hover:bg-violet-700 disabled:opacity-40"
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </form>
    </aside>
  );
}
