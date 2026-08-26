import { useEffect, useId, useRef, useState } from 'react';
import {
  explainFinanceMetric,
  type FinanceAuditSurface,
  type FinanceMetricExplanation,
} from '../../services/financeAuditClient';

interface MetricExplainButtonProps {
  surface: FinanceAuditSurface | string;
  metricId: string;
  label: string;
  value: string;
  detail: string;
  citations: string[];
}

function buildStaticExplanation(detail: string, citations: string[]): FinanceMetricExplanation {
  return {
    explanation: detail,
    bullets: citations.slice(0, 4),
    confidence: 'medium',
    aiGenerated: false,
  };
}

export default function MetricExplainButton({
  surface,
  metricId,
  label,
  value,
  detail,
  citations,
}: MetricExplainButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState<FinanceMetricExplanation>(() => (
    buildStaticExplanation(detail, citations)
  ));
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const fetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setContent(buildStaticExplanation(detail, citations));
    fetchKeyRef.current = null;
  }, [detail, citations, metricId, value]);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    const fetchKey = `${surface}:${metricId}:${value}:${detail}:${citations.join('|')}`;
    if (fetchKeyRef.current === fetchKey) {
      return undefined;
    }

    fetchKeyRef.current = fetchKey;
    let cancelled = false;
    setLoading(true);

    void explainFinanceMetric({
      surface: surface === 'tax' ? 'tax' : 'bookkeeping',
      metricId,
      label,
      value,
      detail,
      citations,
    })
      .then((result) => {
        if (cancelled || !result) return;
        setContent(result);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, surface, metricId, label, value, detail, citations]);

  const bullets = content.bullets.length > 0 ? content.bullets : citations.slice(0, 4);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        data-voice-id={`${surface}-metric-explain-${metricId}`}
        onClick={() => setOpen((current) => !current)}
        className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 transition hover:border-slate-300 hover:text-slate-700"
      >
        Explain
      </button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`Explain ${label}`}
          className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-3 shadow-[0_18px_44px_rgba(15,23,42,0.14)]"
        >
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
          <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
          {loading && (
            <div className="mt-2 text-[11px] font-medium text-violet-600">Enhancing explanation...</div>
          )}
          <p className="mt-2 text-xs leading-relaxed text-slate-600">{content.explanation}</p>
          {bullets.length > 0 && (
            <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3">
              {bullets.map((citation) => (
                <li key={citation} className="text-[11px] leading-relaxed text-slate-500">
                  • {citation}
                </li>
              ))}
            </ul>
          )}
          {content.aiGenerated && content.disclaimer && (
            <p className="mt-3 border-t border-slate-100 pt-2 text-[10px] leading-relaxed text-slate-400">
              {content.disclaimer}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
