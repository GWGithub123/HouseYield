import { useState } from 'react';
import {
  AlertTriangle,
  CalendarPlus,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  Wrench,
} from 'lucide-react';

import type {
  ComponentMaintenanceForecast,
  MaintenanceUrgency,
  PropertyMaintenanceForecast as Forecast,
} from '../../services/propertyHealthForecast';
import { createAssistantScheduledTask } from '../../services/assistantScheduledTasksClient';
import { TwinCard, TwinPill } from './TwinCard';

const URGENCY_META: Record<
  MaintenanceUrgency,
  { label: string; pill: 'positive' | 'warn' | 'danger' | 'info' | 'neutral'; border: string }
> = {
  urgent: { label: 'Urgent', pill: 'danger', border: 'border-rose-200' },
  soon: { label: 'Next 3 months', pill: 'warn', border: 'border-amber-200' },
  verify: { label: 'Verify data', pill: 'info', border: 'border-cyan-200' },
  plan: { label: 'Plan this year', pill: 'warn', border: 'border-slate-200' },
  routine: { label: 'Routine', pill: 'positive', border: 'border-emerald-100' },
};

function money(value: number): string {
  return `$${Math.round(value).toLocaleString()}`;
}

function day(value: string): string {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function ForecastRow({
  forecast,
  propertyId,
  propertyAddress,
}: {
  forecast: ComponentMaintenanceForecast;
  propertyId: string;
  propertyAddress?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reminderState, setReminderState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const meta = URGENCY_META[forecast.urgency];
  const probability = forecast.failureProbability24m == null
    ? null
    : Math.round(forecast.failureProbability24m * 100);

  return (
    <article className={`rounded-xl border bg-white ${meta.border}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-start gap-3 p-3 text-left"
        aria-expanded={open}
      >
        <div
          className={`mt-0.5 rounded-lg p-1.5 ${
            forecast.urgency === 'urgent'
              ? 'bg-rose-100 text-rose-700'
              : forecast.urgency === 'soon'
                ? 'bg-amber-100 text-amber-700'
                : forecast.urgency === 'verify'
                  ? 'bg-cyan-100 text-cyan-700'
                  : 'bg-slate-100 text-slate-600'
          }`}
        >
          {forecast.action === 'confirm'
            ? <ClipboardCheck size={14} />
            : forecast.action === 'replace'
              ? <AlertTriangle size={14} />
              : <Wrench size={14} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-bold text-slate-900">{forecast.name}</span>
            <TwinPill tone={meta.pill}>{meta.label}</TwinPill>
          </div>
          <div className="mt-0.5 text-[11px] font-semibold text-slate-700">
            {forecast.headline} · by {day(forecast.serviceBy)}
          </div>
          <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-500">
            {forecast.recommendation}
          </p>
        </div>
        <ChevronDown
          size={15}
          className={`mt-1 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div className="border-t border-slate-100 px-3 pb-3 pt-2.5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric
              label="24-mo failure risk"
              value={probability == null ? 'Unknown' : `${probability}%`}
              detail={probability == null ? 'Age required' : 'Conditional estimate'}
            />
            <Metric
              label="Timing confidence"
              value={`${forecast.confidence}%`}
              detail={forecast.confidence < 65 ? 'Confirm the source data' : 'Based on current evidence'}
            />
            <Metric
              label="Adjusted life"
              value={`${forecast.effectiveLifeYears} yr`}
              detail={forecast.ageYears == null ? 'Age unknown' : `${forecast.ageYears.toFixed(1)} yr used`}
            />
            <Metric
              label="Action budget"
              value={`${money(forecast.estimatedCostLowUsd)}–${money(forecast.estimatedCostHighUsd)}`}
              detail={forecast.action}
            />
          </div>

          {forecast.window ? (
            <div className="mt-2.5 rounded-lg bg-slate-50 p-2">
              <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">
                Replacement window
              </div>
              <div className="mt-1 grid grid-cols-3 gap-2 text-[10.5px]">
                <span><b className="text-slate-700">Earliest</b><br />{day(forecast.window.earliest)}</span>
                <span><b className="text-slate-700">Likely</b><br />{day(forecast.window.likely)}</span>
                <span><b className="text-slate-700">Latest</b><br />{day(forecast.window.latest)}</span>
              </div>
            </div>
          ) : null}

          {forecast.drivers.length > 0 ? (
            <div className="mt-2.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">
                Why this forecast
              </div>
              <ul className="mt-1 space-y-1">
                {forecast.drivers.slice(0, 5).map((driver, index) => (
                  <li key={`${driver.kind}-${index}`} className="flex gap-1.5 text-[10.5px] leading-snug text-slate-600">
                    <span
                      className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                        driver.impact === 'raises'
                          ? 'bg-amber-500'
                          : driver.impact === 'lowers'
                            ? 'bg-emerald-500'
                            : 'bg-cyan-500'
                      }`}
                    />
                    {driver.label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {forecast.failureModes.length > 0 ? (
            <div className="mt-2.5">
              <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">
                Inspect for
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {forecast.failureModes.map((mode) => (
                  <span key={mode} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                    {mode}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-2.5 flex items-center justify-between border-t border-slate-100 pt-2">
            <span className="text-[10px] text-slate-400">
              {reminderState === 'saved'
                ? 'Reminder scheduled'
                : reminderState === 'error'
                  ? 'Could not schedule reminder'
                  : 'Turn this forecast into an owner reminder'}
            </span>
            <button
              type="button"
              disabled={reminderState === 'saving' || reminderState === 'saved'}
              onClick={async () => {
                setReminderState('saving');
                try {
                  await createAssistantScheduledTask({
                    title: `${forecast.action === 'replace' ? 'Plan replacement' : forecast.action === 'confirm' ? 'Confirm details' : 'Inspect'}: ${forecast.name}`,
                    notes: `${forecast.headline}. ${forecast.recommendation}`,
                    runAt: `${forecast.serviceBy}T09:00:00`,
                    propertyId,
                    propertyAddress,
                    kind: 'reminder',
                    parameters: {
                      source: 'property_health_forecast',
                      assetId: forecast.assetId,
                      forecastRiskScore: forecast.riskScore,
                    },
                  });
                  setReminderState('saved');
                } catch {
                  setReminderState('error');
                }
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 py-1 text-[10.5px] font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              <CalendarPlus size={12} />
              {reminderState === 'saved' ? 'Scheduled' : reminderState === 'saving' ? 'Scheduling…' : 'Set reminder'}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5">
      <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-0.5 text-[12px] font-bold tabular-nums text-slate-900">{value}</div>
      <div className="text-[9.5px] text-slate-400">{detail}</div>
    </div>
  );
}

export default function PropertyMaintenanceForecast({
  forecast,
  propertyId,
  propertyAddress,
}: {
  forecast: Forecast;
  propertyId: string;
  propertyAddress?: string;
}) {
  const visible = forecast.nextActions.length > 0
    ? forecast.nextActions
    : forecast.components.slice(0, 4);

  return (
    <TwinCard
      tone="slate"
      icon={<CalendarClock size={16} />}
      eyebrow="Predictive maintenance"
      title="Next 24 months"
      headerRight={
        <>
          {forecast.urgentCount > 0 ? (
            <TwinPill tone="danger">{forecast.urgentCount} urgent</TwinPill>
          ) : (
            <TwinPill tone="positive" icon={<CheckCircle2 size={11} />}>No urgent work</TwinPill>
          )}
          {forecast.unknownCount > 0 ? (
            <TwinPill tone="info">{forecast.unknownCount} dates to verify</TwinPill>
          ) : null}
        </>
      }
      rail={
        <>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="flex items-center gap-1.5 text-slate-500">
              <CircleDollarSign size={13} />
              <span className="text-[10px] font-bold uppercase tracking-[0.14em]">12-month budget</span>
            </div>
            <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">
              {money(forecast.budget12mLowUsd)}–{money(forecast.budget12mHighUsd)}
            </div>
            <p className="mt-1 text-[10.5px] leading-snug text-slate-500">
              Preventive work and likely replacement actions due within one year.
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
              24-month reserve
            </div>
            <div className="mt-1 text-base font-bold tabular-nums text-slate-800">
              {money(forecast.budget24mLowUsd)}–{money(forecast.budget24mHighUsd)}
            </div>
            <p className="mt-1 text-[10px] leading-snug text-slate-500">
              Planning range, not a quote. Confirm condition before authorizing replacement.
            </p>
          </div>
        </>
      }
    >
      {visible.length > 0 ? (
        <div className="grid gap-2">
          {visible.map((component) => (
            <ForecastRow
              key={component.assetId}
              forecast={component}
              propertyId={propertyId}
              propertyAddress={propertyAddress}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-6 text-center">
          <CheckCircle2 className="mx-auto text-emerald-600" size={22} />
          <div className="mt-1 text-sm font-bold text-emerald-900">No near-term work forecast</div>
          <p className="mt-1 text-[11px] text-emerald-700">
            Keep recording inspections and service so the forecast stays current.
          </p>
        </div>
      )}
    </TwinCard>
  );
}
