import React, { useMemo } from 'react';

export type FilingStatusCode = 'single' | 'mfj' | 'mfs' | 'hoh';

interface ScheduleLinePreview {
  line: number | null;
  name: string;
  amount: number;
}

interface IrsDraftFormWorkspaceProps {
  year: number;
  filingStatus: FilingStatusCode;
  profile: TaxpayerDraftProfile;
  onProfileChange: (next: TaxpayerDraftProfile) => void;
  propertyAddress?: string;
  rulesVersion?: string;
  scheduleIncome?: number;
  scheduleExpenses?: number;
  scheduleNet?: number;
  depreciationTotal?: number;
  scheduleLines: ScheduleLinePreview[];
}

export interface TaxpayerDraftProfile {
  primaryName: string;
  spouseName: string;
  tinLast4: string;
  mailingStreet: string;
  mailingCity: string;
  mailingState: string;
  mailingZip: string;
  withholdingYtd?: string;
  stateWithholdingYtd?: string;
  taxCredits?: string;
  otherDeductions?: string;
  rentalServiceHours?: string;
  priorYearTotalTax?: string;
  priorYearAdjustedGrossIncome?: string;
}

function humanizeFilingStatus(status: FilingStatusCode) {
  switch (status) {
    case 'mfj':
      return 'Married filing jointly';
    case 'mfs':
      return 'Married filing separately';
    case 'hoh':
      return 'Head of household';
    default:
      return 'Single';
  }
}

function updateProfileValue(
  current: TaxpayerDraftProfile,
  key: keyof TaxpayerDraftProfile,
  value: string,
): TaxpayerDraftProfile {
  return { ...current, [key]: value };
}

function fmtMoney(value: number | null | undefined) {
  if (!Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function PaperForm({
  title,
  subtitle,
  badge,
  children,
}: {
  title: string;
  subtitle: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-300 bg-[rgb(249,246,238)] p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-300 pb-3">
        <div>
          <div className="font-serif text-lg font-semibold text-slate-900">{title}</div>
          <div className="mt-1 text-xs text-slate-600">{subtitle}</div>
        </div>
        {badge && (
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900">
            {badge}
          </span>
        )}
      </div>
      <div className="mt-4 space-y-4 font-serif text-[13px] text-slate-900">{children}</div>
    </div>
  );
}

function InputLabel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-slate-600">
      <div className="mb-1 font-medium">{label}</div>
      {children}
    </label>
  );
}

export default function IrsDraftFormWorkspace({
  year,
  filingStatus,
  profile,
  onProfileChange,
  propertyAddress,
  rulesVersion,
  scheduleIncome,
  scheduleExpenses,
  scheduleNet,
  depreciationTotal,
  scheduleLines,
}: IrsDraftFormWorkspaceProps) {
  const sortedScheduleLines = useMemo(() => {
    const byLine = [...scheduleLines]
      .filter((line) => line.line !== null || Number(line.amount || 0) !== 0)
      .sort((left, right) => Number(left.line || 999) - Number(right.line || 999));

    const hasRentLine = byLine.some((line) => line.line === 3);
    const hasDepreciationLine = byLine.some((line) => line.line === 18);
    const synthetic = [] as ScheduleLinePreview[];

    if (!hasRentLine && Number(scheduleIncome || 0) > 0) {
      synthetic.push({ line: 3, name: 'Rents received', amount: Number(scheduleIncome || 0) });
    }
    if (!hasDepreciationLine && Number(depreciationTotal || 0) > 0) {
      synthetic.push({ line: 18, name: 'Depreciation expense', amount: Number(depreciationTotal || 0) });
    }

    return [...byLine, ...synthetic].sort((left, right) => Number(left.line || 999) - Number(right.line || 999));
  }, [depreciationTotal, scheduleIncome, scheduleLines]);

  const displayName = filingStatus === 'mfj' && profile.spouseName.trim()
    ? `${profile.primaryName.trim() || 'Primary taxpayer'} & ${profile.spouseName.trim()}`
    : profile.primaryName.trim() || 'Primary taxpayer';
  const mailingLine = [profile.mailingStreet, profile.mailingCity, profile.mailingState, profile.mailingZip]
    .filter(Boolean)
    .join(profile.mailingCity ? ', ' : ' ');

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">Taxpayer profile & planning forms</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              Separate preview track for planning-form layout. This is distinct from the workpaper exports below and is labeled as planning preview only.
            </p>
          </div>
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900">
            Planning only
          </span>
        </div>
      </div>

      <div className="border-b border-slate-100 px-5 py-5">
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          These layouts are Schedule E support previews, not filed returns. They keep taxpayer identity attached to the rental workpapers, but final return preparation still belongs with a CPA or tax-prep software.
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          <InputLabel label="Primary taxpayer name">
            <input
              type="text"
              value={profile.primaryName}
              onChange={(event) => onProfileChange(updateProfileValue(profile, 'primaryName', event.target.value))}
              placeholder="Owner name"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </InputLabel>
          <InputLabel label={filingStatus === 'mfj' ? 'Spouse name' : 'Second taxpayer'}>
            <input
              type="text"
              value={profile.spouseName}
              onChange={(event) => onProfileChange(updateProfileValue(profile, 'spouseName', event.target.value))}
              placeholder={filingStatus === 'mfj' ? 'Spouse name' : 'Optional'}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </InputLabel>
          <InputLabel label="TIN last 4">
            <input
              type="text"
              value={profile.tinLast4}
              maxLength={4}
              onChange={(event) => onProfileChange(updateProfileValue(profile, 'tinLast4', event.target.value.replace(/\D/g, '')))}
              placeholder="1234"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </InputLabel>
          <InputLabel label="Mailing street">
            <input
              type="text"
              value={profile.mailingStreet}
              onChange={(event) => onProfileChange(updateProfileValue(profile, 'mailingStreet', event.target.value))}
              placeholder="123 Main St"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </InputLabel>
          <InputLabel label="Mailing city">
            <input
              type="text"
              value={profile.mailingCity}
              onChange={(event) => onProfileChange(updateProfileValue(profile, 'mailingCity', event.target.value))}
              placeholder="Pittsburgh"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </InputLabel>
          <InputLabel label="Mailing state">
            <input
              type="text"
              value={profile.mailingState}
              onChange={(event) => onProfileChange(updateProfileValue(profile, 'mailingState', event.target.value.toUpperCase()))}
              maxLength={2}
              placeholder="PA"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </InputLabel>
          <InputLabel label="Mailing ZIP">
            <input
              type="text"
              value={profile.mailingZip}
              onChange={(event) => onProfileChange(updateProfileValue(profile, 'mailingZip', event.target.value))}
              placeholder="15222"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </InputLabel>
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
            <div className="font-semibold uppercase tracking-wider text-slate-500">Draft packet context</div>
            <div className="mt-2 space-y-1">
              <div>Filing status: <span className="font-medium text-slate-900">{humanizeFilingStatus(filingStatus)}</span></div>
              <div>Taxpayer: <span className="font-medium text-slate-900">{displayName}</span></div>
              <div>Mailing line: <span className="font-medium text-slate-900">{mailingLine || 'Not entered'}</span></div>
              <div>Rules version: <span className="font-medium text-slate-900">{rulesVersion || 'Not loaded'}</span></div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 p-5 xl:grid-cols-2">
        <PaperForm
          title={`Schedule E draft preview · ${year}`}
          subtitle="Supplemental Income and Loss preview, line-mapped from the active tax rules package."
          badge="Draft filing form"
        >
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2">
              <div className="font-semibold uppercase tracking-wider text-slate-500">Taxpayer</div>
              <div className="mt-1">{displayName}</div>
              <div className="text-slate-500">TIN ending {profile.tinLast4 || '____'}</div>
            </div>
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2">
              <div className="font-semibold uppercase tracking-wider text-slate-500">Property / scope</div>
              <div className="mt-1">{propertyAddress || 'Portfolio scope'}</div>
              <div className="text-slate-500">Rules {rulesVersion || 'not loaded'}</div>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-slate-300 bg-white">
            <div className="grid grid-cols-[64px_minmax(0,1fr)_132px] border-b border-slate-300 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <div>Line</div>
              <div>Description</div>
              <div className="text-right">Amount</div>
            </div>
            {sortedScheduleLines.length === 0 ? (
              <div className="px-3 py-4 text-sm text-slate-500">No Schedule E lines are currently available for preview.</div>
            ) : (
              sortedScheduleLines.map((line) => (
                <div key={`${line.line}-${line.name}`} className="grid grid-cols-[64px_minmax(0,1fr)_132px] border-t border-slate-200 px-3 py-2 text-sm">
                  <div className="font-mono text-slate-600">{line.line ?? '—'}</div>
                  <div>{line.name}</div>
                  <div className="text-right tabular-nums">{fmtMoney(line.amount)}</div>
                </div>
              ))
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2">
              <div className="font-semibold uppercase tracking-wider text-slate-500">Income</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{fmtMoney(scheduleIncome)}</div>
            </div>
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2">
              <div className="font-semibold uppercase tracking-wider text-slate-500">Expenses</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{fmtMoney(scheduleExpenses)}</div>
            </div>
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2">
              <div className="font-semibold uppercase tracking-wider text-slate-500">Depreciation</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{fmtMoney(depreciationTotal)}</div>
            </div>
            <div className="rounded-md border border-slate-300 bg-white px-3 py-2">
              <div className="font-semibold uppercase tracking-wider text-slate-500">Net rental result</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{fmtMoney(scheduleNet)}</div>
            </div>
          </div>

          <div className="text-[11px] text-slate-500">
            This preview is line-mapped from the current canonical Schedule E output and is meant for review. Final filing still depends on full taxpayer context and CPA or preparer review.
          </div>
        </PaperForm>
      </div>
    </div>
  );
}