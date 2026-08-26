import { Plus, GitCompare, Trash2, Bot, Pin, Check, X } from 'lucide-react';
import type { FIScenarioSummary } from '../types';

interface ScenarioTrayProps {
  scenarios: FIScenarioSummary[];
  activeId: string | null;
  appliedIds: string[];
  compareIds: string[];
  liveFiYear: number | null;
  currentFiYear: number | null;
  onResetToLive: () => void;
  onToggleApplied: (id: string) => void;
  onToggleCompare: (id: string) => void;
  onSave: () => void;
  onDelete: (id: string) => void;
  saving?: boolean;
}

function ScenarioChip({
  scenario,
  applied,
  active,
  comparing,
  appliedIndex,
  onToggleApplied,
  onToggleCompare,
  onDelete,
}: {
  scenario: FIScenarioSummary;
  applied: boolean;
  active: boolean;
  comparing: boolean;
  appliedIndex: number;
  onToggleApplied: () => void;
  onToggleCompare: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${
        applied
          ? 'border-sky-300 bg-sky-50'
          : comparing
            ? 'border-violet-300 bg-violet-50'
            : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <div className="flex items-center gap-2 text-left">
        {scenario.source === 'ai' ? <Bot size={13} className="text-violet-500" /> : null}
        <span className="text-sm font-medium text-slate-800">{scenario.name}</span>
        {applied ? (
          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${active ? 'bg-emerald-100 text-emerald-700' : 'bg-sky-100 text-sky-700'}`}>
            <Check size={9} /> #{appliedIndex + 1}
          </span>
        ) : (
          <span
            className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
              scenario.fiYear ? 'bg-slate-100 text-slate-600' : 'bg-rose-50 text-rose-500'
            }`}
          >
            {scenario.fiYear ? `FI ${scenario.fiYear}` : 'no FI'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onToggleApplied}
          title={applied ? 'Remove from applied stack' : 'Apply on top of the current stack'}
          className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
            applied
              ? 'bg-white text-slate-600 hover:text-rose-600'
              : 'bg-slate-900 text-white hover:bg-slate-700'
          }`}
        >
          {applied ? 'Remove' : 'Apply'}
        </button>
        <button
          type="button"
          onClick={onToggleCompare}
          title={comparing ? 'Stop comparing' : 'Pin to compare'}
          className={`rounded-md p-1 transition-colors ${
            comparing ? 'text-violet-600' : 'text-slate-300 hover:text-slate-500'
          }`}
        >
          <Pin size={12} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete scenario"
          className="rounded-md p-1 text-slate-300 opacity-0 transition-all hover:text-rose-500 group-hover:opacity-100"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

export default function ScenarioTray({
  scenarios,
  activeId,
  appliedIds,
  compareIds,
  liveFiYear,
  currentFiYear,
  onResetToLive,
  onToggleApplied,
  onToggleCompare,
  onSave,
  onDelete,
  saving,
}: ScenarioTrayProps) {
  const baselineName = appliedIds.length ? 'Applied stack' : 'Live plan';
  const baselineFi = appliedIds.length ? currentFiYear : liveFiYear;
  const compared = scenarios.filter((scenario) => compareIds.includes(scenario.id) && !appliedIds.includes(scenario.id));
  const appliedNames = appliedIds
    .map((id) => scenarios.find((scenario) => scenario.id === id)?.name)
    .filter((value): value is string => Boolean(value));

  return (
    <div className="hy-glass-card p-3">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Scenarios
        </span>
        <span className="hidden text-[11px] text-slate-400 sm:inline">Apply to stack · Pin to compare</span>
      </div>

      {appliedNames.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-sky-50/80 px-3 py-2 text-sm">
          <span className="font-medium text-slate-700">Applied:</span>
          {appliedNames.map((name, index) => (
            <span key={`${name}-${index}`} className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-sky-700 shadow-sm">
              #{index + 1} {name}
            </span>
          ))}
          {currentFiYear ? <span className="text-xs text-slate-500">Current FI {currentFiYear}</span> : null}
          <button
            type="button"
            onClick={onResetToLive}
            className="ml-auto inline-flex items-center gap-1 rounded-md text-xs font-medium text-slate-500 transition-colors hover:text-slate-700"
          >
            <X size={12} /> Reset
          </button>
        </div>
      ) : null}

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={onResetToLive}
          title="Your current live plan"
          className={`inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${
            appliedIds.length === 0
              ? 'border-sky-300 bg-sky-50'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <span className="text-sm font-medium text-slate-800">Live plan</span>
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
            {liveFiYear ? `FI ${liveFiYear}` : 'no FI'}
          </span>
        </button>

        {scenarios.map((scenario) => {
          const appliedIndex = appliedIds.indexOf(scenario.id);
          return (
            <ScenarioChip
              key={scenario.id}
              scenario={scenario}
              applied={appliedIndex >= 0}
              active={scenario.id === activeId}
              comparing={compareIds.includes(scenario.id)}
              appliedIndex={appliedIndex}
              onToggleApplied={() => onToggleApplied(scenario.id)}
              onToggleCompare={() => onToggleCompare(scenario.id)}
              onDelete={() => onDelete(scenario.id)}
            />
          );
        })}

        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-dashed border-slate-300 px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:border-sky-300 hover:text-sky-600 disabled:opacity-50"
        >
          <Plus size={14} /> {saving ? 'Saving…' : 'Save current'}
        </button>
      </div>

      {compared.length ? (
        <div className="mt-2 rounded-xl bg-violet-50/70 px-3 py-2">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-violet-500">
            <GitCompare size={13} /> Comparing vs {baselineName}
            {baselineFi ? <span className="font-normal normal-case text-slate-500">(FI {baselineFi})</span> : null}
          </div>
          <div className="flex flex-col gap-1">
            {compared.map((scenario) => {
              const diff = scenario.fiYear != null && baselineFi != null ? scenario.fiYear - baselineFi : null;
              return (
                <div key={scenario.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex items-center gap-1.5 font-medium text-slate-700">
                    <Pin size={11} className="text-violet-500" /> {scenario.name}
                  </span>
                  {diff === null ? (
                    <span className="text-slate-400">{scenario.fiYear ? `FI ${scenario.fiYear}` : 'no FI'}</span>
                  ) : diff === 0 ? (
                    <span className="text-slate-500">Same FI year</span>
                  ) : (
                    <span className={diff < 0 ? 'font-medium text-emerald-600' : 'font-medium text-rose-500'}>
                      FI {scenario.fiYear} · {Math.abs(diff)} {Math.abs(diff) === 1 ? 'yr' : 'yrs'} {diff < 0 ? 'sooner' : 'later'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
