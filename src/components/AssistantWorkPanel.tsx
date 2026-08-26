import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert, Droplets, LoaderCircle, Thermometer, Waves, Wifi, X } from 'lucide-react';
import type { AssistantActivityRun } from '../contexts/AssistantActivityContext';
import type {
  AssistantActionResultPayload,
  AssistantPadAction,
  AssistantPdfResult,
  AssistantSensorInsightResult,
} from '../services/assistantActionResultTypes';
import { buildOwnerFinanceUrl, requestOwnerFinanceBlob } from '../services/ownerFinanceApi';
import { useDialogFocusTrap } from '../design-system/hooks/useDialogFocusTrap';
import { AssistantFluidLoader } from './AssistantFluidLoader';

type Props = {
  run: AssistantActivityRun | null;
  onClose: () => void;
  onAction: (action: AssistantPadAction, edits?: { subject?: string; body?: string; fields?: Record<string, string> }) => Promise<void>;
};

function money(value: number) {
  return `$${Math.round(Number(value) || 0).toLocaleString()}`;
}

function AuthenticatedPdfPreview({
  result,
  onNavigate,
}: {
  result: AssistantPdfResult;
  onNavigate?: (route: string) => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    const load = async () => {
      setLoading(true);
      setError(null);
      setBlobUrl(null);
      try {
        const blob = await requestOwnerFinanceBlob(buildOwnerFinanceUrl(result.url));
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load document preview.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [result.url]);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold text-slate-950">{result.title}</div>
          <div className="mt-0.5 text-xs text-slate-500">
            {[result.formLabel, result.status, result.propertyAddress].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
        {loading ? (
          <div className="flex min-h-[280px] items-center justify-center gap-2 text-sm text-slate-500">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading document…
          </div>
        ) : error ? (
          <div className="space-y-2 p-4 text-sm text-slate-600">
            <p>{error}</p>
            <p className="text-xs text-slate-500">Use Open full size or Open in Documents below.</p>
          </div>
        ) : blobUrl ? (
          <iframe
            title={result.title || 'Document preview'}
            src={blobUrl}
            className="h-[min(52vh,420px)] w-full bg-white"
          />
        ) : null}
      </div>

      {result.relatedDocuments?.length ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">Also on file</div>
          {result.relatedDocuments.map((doc) => (
            <button
              key={doc.id}
              type="button"
              onClick={() => {
                if (doc.route) onNavigate?.(doc.route);
              }}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:bg-slate-50"
            >
              <span className="min-w-0 truncate font-medium text-slate-800">{doc.title}</span>
              <span className="shrink-0 text-xs text-slate-500">{doc.status || 'Open'}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (normalized === 'online' || normalized === 'sleeping') return 'bg-emerald-50 text-emerald-800';
  if (normalized === 'offline') return 'bg-rose-50 text-rose-800';
  return 'bg-slate-100 text-slate-700';
}

function deviceIcon(type: string) {
  if (type === 'temperature_humidity' || type === 'temperature' || type === 'humidity') return Thermometer;
  if (type === 'water_leak') return Droplets;
  if (type === 'automatic_shutoff_controller') return Waves;
  return Wifi;
}

function SensorInsightView({ result }: { result: AssistantSensorInsightResult }) {
  const devices = result.devices || [];
  const focused = devices.filter((device) => device.focused);
  const shown = (focused.length ? focused : devices).slice(0, 8);
  const remaining = Math.max(0, (focused.length ? focused : devices).length - shown.length);

  return (
    <div className="space-y-3">
      {result.metrics?.length ? (
        <div className="grid grid-cols-3 gap-2">
          {result.metrics.slice(0, 6).map((metric) => (
            <div key={metric.label} className="rounded-xl bg-slate-50 px-2.5 py-2">
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{metric.label}</div>
              <div className="mt-0.5 text-base font-semibold text-slate-950">{metric.value}</div>
            </div>
          ))}
        </div>
      ) : null}

      {shown.length ? (
        <div className="space-y-2">
          {shown.map((device) => {
            const Icon = deviceIcon(device.type);
            return (
              <div
                key={device.id}
                className={`rounded-2xl border p-3 ${
                  device.focused || device.flooded
                    ? 'border-blue-300 bg-blue-50/70'
                    : 'border-slate-200 bg-white'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                    <Icon size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="truncate font-semibold text-slate-950">{device.name}</div>
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusTone(device.status)}`}>
                        {device.status}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">{device.kindLabel}{device.location ? ` · ${device.location}` : ''}</div>
                    {device.readingLabel ? (
                      <div className="mt-2 text-sm font-medium text-slate-800">{device.readingLabel}</div>
                    ) : null}
                    {(device.temperatureF != null || device.humidityPercent != null) && device.readingLabel == null ? (
                      <div className="mt-2 flex flex-wrap gap-2 text-sm font-medium text-slate-800">
                        {device.temperatureF != null ? <span>{device.temperatureF}°F</span> : null}
                        {device.humidityPercent != null ? <span>{device.humidityPercent}% RH</span> : null}
                      </div>
                    ) : null}
                    {device.valveState ? (
                      <div className="mt-2 text-sm font-medium text-slate-800">Valve {device.valveState}</div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
          {remaining > 0 ? (
            <p className="text-xs text-slate-500">+{remaining} more device{remaining === 1 ? '' : 's'} on Predictive Maintenance</p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm leading-6 text-slate-700">{result.summary}</p>
      )}

      {result.openAlerts?.length ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">Open alerts</div>
          <ul className="mt-2 space-y-1.5">
            {result.openAlerts.map((alert) => (
              <li key={alert.id} className="text-sm text-amber-950">
                <span className="font-medium">{alert.deviceName}</span> — {alert.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.recommendations?.length ? (
        <ul className="space-y-1.5 text-sm text-slate-600">
          {result.recommendations.slice(0, 4).map((item) => (
            <li key={item} className="flex gap-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ResultView({
  result,
  subject,
  body,
  fields,
  onSubjectChange,
  onBodyChange,
  onFieldChange,
  onNavigate,
}: {
  result: AssistantActionResultPayload;
  subject: string;
  body: string;
  fields: Record<string, string>;
  onSubjectChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onFieldChange: (id: string, value: string) => void;
  onNavigate?: (route: string) => void;
}) {
  if (result.type === 'message_draft') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">To {result.toName || result.toEmail || 'recipient'}</p>
        <label className="block text-sm font-medium text-slate-700">
          Subject
          <input value={subject} onChange={(event) => onSubjectChange(event.target.value)} className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2" />
        </label>
        <label className="block text-sm font-medium text-slate-700">
          Message
          <textarea value={body} onChange={(event) => onBodyChange(event.target.value)} rows={6} className="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 leading-6" />
        </label>
      </div>
    );
  }
  if (result.type === 'needs_input') {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-6 text-slate-700">{result.message}</p>
        {result.fields.map((field) => (
          <label key={field.id} className="block text-sm font-medium text-slate-700">
            {field.label}
            <input
              type={field.inputType || 'text'}
              required={field.required}
              value={fields[field.id] || ''}
              placeholder={field.placeholder}
              onChange={(event) => onFieldChange(field.id, event.target.value)}
              className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </label>
        ))}
      </div>
    );
  }
  if (result.type === 'expense_breakdown') {
    return (
      <div>
        <div className="flex items-center justify-between gap-3 font-semibold text-slate-950">
          <span>{result.title}</span><span>{money(result.total)}</span>
        </div>
        <div className="mt-3 divide-y divide-slate-100">
          {result.lines.map((line, index) => (
            <div key={`${line.id || line.label}-${index}`} className="flex justify-between gap-4 py-2 text-sm">
              <span className="text-slate-700">{line.label}</span><span className="font-medium">{money(line.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (result.type === 'property_analysis') {
    return (
      <div className="space-y-3">
        {result.verdict ? <p className="rounded-xl bg-amber-50 p-3 font-medium text-amber-950">{result.verdict}</p> : null}
        <p className="text-sm leading-6 text-slate-700">{result.summary}</p>
        {result.metrics?.length ? (
          <div className="grid grid-cols-2 gap-2">
            {result.metrics.map((metric) => (
              <div key={metric.label} className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">{metric.label}</div>
                <div className="font-semibold">{metric.value}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  if (result.type === 'sensor_insight') {
    return <SensorInsightView result={result} />;
  }
  if (result.type === 'document_list') {
    return (
      <div className="space-y-2">
        {result.documents.length ? result.documents.map((doc) => (
          <button
            key={doc.id}
            type="button"
            onClick={() => {
              if (doc.route) onNavigate?.(doc.route);
            }}
            className="flex w-full items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3 text-left transition hover:border-slate-300 hover:bg-slate-50"
          >
            <div className="min-w-0">
              <div className="truncate font-semibold text-slate-950">{doc.title}</div>
              <div className="mt-0.5 text-xs text-slate-500">
                {[doc.status, doc.propertyAddress].filter(Boolean).join(' · ')}
              </div>
            </div>
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
              Open
            </span>
          </button>
        )) : (
          <p className="text-sm leading-6 text-slate-700">{result.summary}</p>
        )}
      </div>
    );
  }
  if (result.type === 'daily_briefing') {
    return (
      <div className="space-y-2">
        {result.sections.map((section) => (
          <div key={section.id} className="rounded-xl border border-slate-200 p-3">
            <div className="font-medium">{section.headline}</div>
            <div className="mt-1 text-xs text-slate-500">{section.label}</div>
          </div>
        ))}
      </div>
    );
  }
  if (result.type === 'scheduled_tasks') {
    return (
      <div className="space-y-2">
        {result.tasks.map((task) => (
          <div key={task.id} className="rounded-xl border border-slate-200 p-3">
            <div className="font-medium">{task.title}</div>
            <div className="mt-1 text-xs text-slate-500">{new Date(task.runAt).toLocaleString()}</div>
          </div>
        ))}
      </div>
    );
  }
  if (result.type === 'document') {
    return (
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm leading-6 text-slate-700">
        {result.previewText || result.content || 'Document ready.'}
      </pre>
    );
  }
  if (result.type === 'pdf') {
    return <AuthenticatedPdfPreview result={result} onNavigate={onNavigate} />;
  }

  if (result.type === 'generic') {
    return result.details?.length ? (
      <ul className="list-disc space-y-2 pl-5 text-sm text-slate-600">
        {result.details.map((item) => <li key={item}>{item}</li>)}
      </ul>
    ) : null;
  }

  const summary = result.type === 'confirmation'
    ? result.message
    : result.type === 'maintenance_case'
      ? result.issueSummary || result.nextStep
      : result.summary;
  const bullets = result.type === 'market_insight'
    ? result.bullets
    : undefined;
  return (
    <div>
      {summary ? <p className="text-sm leading-6 text-slate-700">{summary}</p> : null}
      {bullets?.length ? (
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-600">
          {bullets.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

export function AssistantWorkPanel({ run, onClose, onAction }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const resultAnchorRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [confirmAction, setConfirmAction] = useState<AssistantPadAction | null>(null);

  useDialogFocusTrap(Boolean(run), panelRef);

  useEffect(() => {
    setSubject(run?.result?.type === 'message_draft' ? run.result.subject : '');
    setBody(run?.result?.type === 'message_draft' ? run.result.body : '');
    setFields({});
    setNotice('');
    setConfirmAction(null);
  }, [run?.runId]);

  useEffect(() => {
    if (!run) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, run]);

  useEffect(() => {
    if (!run || !bodyRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      if ((run.status === 'complete' || run.status === 'error') && resultAnchorRef.current) {
        if (typeof resultAnchorRef.current.scrollIntoView === 'function') {
          resultAnchorRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        return;
      }
      bodyRef.current?.scrollTo?.({
        top: bodyRef.current.scrollHeight,
        behavior: 'smooth',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [run?.runId, run?.status, run?.currentStep, run?.result, run?.detailMessage]);

  const statusLabel = run?.status === 'complete' ? 'Ready' : run?.status === 'error' ? 'Needs attention' : 'Working';
  const highlights = useMemo(() => {
    if (!run) return [];
    if (run.result?.type === 'sensor_insight') return [];
    if (run.highlights.length) return run.highlights;
    if (run.result?.presentation?.highlights?.length) return run.result.presentation.highlights.slice(0, 5);
    if (run.result?.type === 'property_analysis') return run.result.bullets?.slice(0, 3) || [];
    if (run.result?.type === 'generic') return run.result.details?.slice(0, 3) || [];
    return [];
  }, [run]);

  const invoke = async (action: AssistantPadAction) => {
    setBusyId(action.id);
    setNotice('');
    try {
      await onAction(action, { subject, body, fields });
      if (action.kind === 'navigate') {
        setNotice(action.route ? `Opened ${action.label}.` : `${action.label} done.`);
      } else if (action.kind === 'open' || action.kind === 'download') {
        setNotice(action.kind === 'download' ? 'Download started.' : 'Opened in a new tab.');
      } else {
        setNotice(`${action.label} done.`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Action could not be completed.');
    } finally {
      setBusyId(null);
    }
  };

  const requestAction = (action: AssistantPadAction) => {
    const consequential = /send|sign|rent|payment|delete|remove|account|setting/i.test(`${action.id} ${action.label}`);
    if (consequential) {
      setConfirmAction(action);
      return;
    }
    void invoke(action);
  };

  const explain = () => {
    if (!run) return;
    window.dispatchEvent(new CustomEvent('houseyield:assistant-prompt', {
      detail: {
        prompt: `Explain this result in plain language for a landlord, answering directly without saying the word highlights: ${run.summary}`,
        modalities: ['text'],
        source: 'work-panel',
      },
    }));
  };

  const copyResult = async () => {
    if (!run) return;
    const text = [run.title, run.summary, ...highlights].filter(Boolean).join('\n');
    await navigator.clipboard.writeText(text);
    setNotice('Copied to your clipboard.');
  };

  const readAloud = () => {
    if (!run || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance([run.summary, ...highlights].join('. ')));
    setNotice('Reading the summary aloud.');
  };

  if (!run || typeof document === 'undefined') return null;

  const isRunning = run.status === 'running';
  const stepsSection = run.steps.length ? (
    <section aria-labelledby="assistant-steps-heading" className="rounded-2xl border border-slate-200 bg-white/80 p-3.5">
      <h3 id="assistant-steps-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        {isRunning ? 'What I\u2019m doing' : 'What I did'}
      </h3>
      <ol className="mt-3 space-y-2.5">
        {run.steps.map((step, index) => {
          const done = run.status === 'complete' || index < run.currentStep;
          const active = isRunning && index === run.currentStep;
          const failed = run.status === 'error' && index === run.currentStep;
          return (
            <li key={`${step}-${index}`} className="transition-all duration-300 motion-reduce:transition-none">
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                  {failed ? (
                    <CircleAlert className="h-5 w-5 text-red-500" />
                  ) : active ? (
                    <LoaderCircle className="h-5 w-5 animate-spin text-blue-600 motion-reduce:animate-none" />
                  ) : done ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 transition-colors duration-300 motion-reduce:transition-none">
                      <Check className="h-3.5 w-3.5 text-emerald-600" />
                    </span>
                  ) : (
                    <span className="h-4 w-4 rounded-full border-2 border-slate-300" />
                  )}
                </span>
                <span
                  className={`text-sm leading-6 transition-all duration-300 motion-reduce:transition-none ${
                    active
                      ? 'font-medium text-slate-900'
                      : done
                        ? 'text-slate-400 line-through decoration-slate-300'
                        : failed
                          ? 'font-medium text-red-700'
                          : 'text-slate-500'
                  }`}
                >
                  {step}
                </span>
              </div>
              {active && run.detailMessage ? (
                <p className="ml-[30px] mt-1 text-[13px] italic leading-5 text-slate-500">
                  {run.detailMessage}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  ) : null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={subtitleId}
      tabIndex={-1}
      className="fixed bottom-5 right-5 z-[10002] flex max-h-[min(88vh,820px)] w-[min(480px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[24px] border border-slate-200/80 bg-[#fffdf7] shadow-[0_24px_80px_rgba(15,23,42,0.24)] outline-none motion-reduce:transition-none"
    >
      <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 px-4 py-3">
        <div className="min-w-0">
          <h2 id={titleId} className="truncate text-base font-semibold tracking-tight text-slate-950">
            {run.title || 'Assistant work'}
          </h2>
          <p id={subtitleId} className="mt-0.5 text-sm text-slate-500">{statusLabel}</p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <X size={18} />
        </button>
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 scroll-smooth" aria-live="polite">
        {!isRunning ? (
          <section aria-labelledby="assistant-answer-heading">
            <h3 id="assistant-answer-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Answer
            </h3>
            <p className="mt-2 text-[15px] leading-7 text-slate-900">
              {run.result?.presentation?.headline || run.summary}
            </p>
            {highlights.length ? (
              <ul className="mt-3 space-y-2">
                {highlights.map((item) => (
                  <li key={item} className="flex gap-2 text-sm leading-6 text-slate-700">
                    <Check className="mt-1 h-4 w-4 shrink-0 text-emerald-600" />
                    {item}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : (
          <section aria-labelledby="assistant-request-heading">
            <h3 id="assistant-request-heading" className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Your request
            </h3>
            <p className="mt-2 text-[15px] leading-7 text-slate-900">{run.summary}</p>
          </section>
        )}

        {isRunning ? stepsSection : null}

        {isRunning ? (
          <AssistantFluidLoader
            active
            label={
              /document|lease|addendum|pdf/i.test(`${run.actionId} ${run.title}`)
                ? 'Preparing your document…'
                : run.title || 'Working on your request…'
            }
            detail={run.detailMessage || run.steps[run.currentStep] || 'You can keep watching the checklist while I finish.'}
          />
        ) : null}

        {run.result && !(run.result.type === 'generic' && !(run.result.details?.length)) ? (
          <div ref={resultAnchorRef}>
            <section className={`rounded-2xl border border-slate-200 bg-white p-3.5 ${run.result.type === 'pdf' ? 'p-2.5' : ''}`}>
              <ResultView
                result={run.result}
                subject={subject}
                body={body}
                fields={fields}
                onSubjectChange={setSubject}
                onBodyChange={setBody}
                onFieldChange={(id, value) => setFields((current) => ({ ...current, [id]: value }))}
                onNavigate={(route) => {
                  void onAction({ id: 'navigate-result', label: 'Open', kind: 'navigate', route });
                }}
              />
            </section>
          </div>
        ) : (
          <div ref={resultAnchorRef} />
        )}

        {!isRunning && run.steps.length ? (
          <details className="rounded-2xl border border-slate-200 bg-white/70">
            <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              What I did ({run.steps.length} steps)
            </summary>
            <ol className="space-y-2 border-t border-slate-200 px-4 py-3">
              {run.steps.map((step, index) => (
                <li key={`${step}-${index}`} className="flex gap-2 text-sm text-slate-500">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <span className="line-through decoration-slate-300">{step}</span>
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        {run.error ? (
          <div role="alert" className="flex gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-800">
            <CircleAlert className="h-5 w-5 shrink-0" />
            {run.error}
          </div>
        ) : null}
        {notice ? <div role="status" className="rounded-xl bg-slate-100 p-3 text-sm text-slate-700">{notice}</div> : null}

        {confirmAction ? (
          <section role="alertdialog" aria-labelledby="assistant-confirm-heading" className="rounded-2xl border border-amber-300 bg-amber-50 p-3.5">
            <h3 id="assistant-confirm-heading" className="font-semibold text-amber-950">Review before continuing</h3>
            <p className="mt-1 text-sm leading-6 text-amber-900">This can change data or contact someone. Nothing happens until you confirm.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const action = confirmAction;
                  setConfirmAction(null);
                  void invoke(action);
                }}
                className="min-h-11 rounded-xl bg-amber-950 px-4 text-sm font-semibold text-white"
              >
                Confirm {confirmAction.label}
              </button>
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="min-h-11 rounded-xl border border-amber-400 bg-white px-4 text-sm font-semibold text-amber-950"
              >
                Cancel
              </button>
            </div>
          </section>
        ) : null}

        {run.actions?.length ? (
          <section aria-label="Available actions" className="flex flex-wrap gap-2">
            {run.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                disabled={Boolean(busyId)}
                onClick={() => requestAction(action)}
                className={`min-h-11 rounded-xl px-4 py-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  action.primary
                    ? 'bg-slate-950 text-white'
                    : 'border border-slate-300 bg-white text-slate-800'
                } disabled:opacity-50`}
              >
                {busyId === action.id ? 'Working…' : action.label}
              </button>
            ))}
          </section>
        ) : null}

        {run.result?.presentation?.rationale?.length || run.result?.presentation?.sourceLabel ? (
          <details className="rounded-2xl border border-slate-200 bg-white/70">
            <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
              How this was done
            </summary>
            <div className="border-t border-slate-200 px-4 py-3">
              {run.result?.presentation?.rationale?.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
                  {run.result.presentation.rationale.map((item) => <li key={item}>{item}</li>)}
                </ul>
              ) : null}
              {run.result?.presentation?.sourceLabel ? (
                <p className="mt-3 text-xs text-slate-500">
                  Source: {run.result.presentation.sourceLabel}
                  {run.result.presentation.freshAsOf ? ` • Fresh as of ${run.result.presentation.freshAsOf}` : ''}
                  {run.result.presentation.confidence ? ` • ${run.result.presentation.confidence} confidence` : ''}
                </p>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2 border-t border-slate-200/70 bg-[#fffdf7] px-4 py-3" aria-label="Result tools">
        {isRunning ? (
          <button type="button" onClick={onClose} className="min-h-11 rounded-full border border-slate-300 px-3 text-sm font-semibold text-slate-700">
            Pause guidance
          </button>
        ) : (
          <>
            <button type="button" onClick={explain} className="min-h-11 rounded-full border border-slate-300 px-3 text-sm font-semibold text-slate-700">
              Explain this
            </button>
            <button type="button" onClick={() => void copyResult()} className="min-h-11 rounded-full border border-slate-300 px-3 text-sm font-semibold text-slate-700">
              Copy
            </button>
            <button type="button" onClick={readAloud} className="min-h-11 rounded-full border border-slate-300 px-3 text-sm font-semibold text-slate-700">
              Read aloud
            </button>
            <button type="button" onClick={() => window.history.back()} className="min-h-11 rounded-full border border-slate-300 px-3 text-sm font-semibold text-slate-700">
              Back where I was
            </button>
          </>
        )}
        {run.status === 'error' ? (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('houseyield:assistant-prompt', {
              detail: { prompt: `Retry this request: ${run.summary}`, modalities: ['text'], source: 'work-panel-retry' },
            }))}
            className="min-h-11 rounded-full border border-slate-300 px-3 text-sm font-semibold text-slate-700"
          >
            Retry
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export default AssistantWorkPanel;
