import React from 'react';

export type SourceKind = 'sample' | 'stripe' | 'bank' | 'manual' | 'qbo' | 'receipt' | 'other';

export interface FinanceSourceLike {
  source?: string | null;
}

export interface FinanceSourceMix {
  total: number;
  mix: Record<SourceKind, number>;
  hasSample: boolean;
  hasLive: boolean;
  samplePct: number;
  livePct: number;
  headline: string;
  tone: 'amber' | 'emerald' | 'slate';
}

const SAMPLE_SOURCES = new Set(['SAMPLE_FEED', 'SAMPLE', 'MOCK_BANK', 'MOCK_STRIPE', 'HOUSEYIELD_FIXTURE']);
const STRIPE_SOURCES = new Set(['STRIPE', 'STRIPE_FC']);
const BANK_SOURCES = new Set(['BANK', 'PLAID']);

const KIND_LABELS: Record<SourceKind, string> = {
  sample: 'Sample',
  stripe: 'Stripe',
  bank: 'Bank',
  manual: 'Manual',
  qbo: 'QuickBooks',
  receipt: 'Receipt',
  other: 'Other',
};

const KIND_ORDER: SourceKind[] = ['sample', 'stripe', 'bank', 'manual', 'qbo', 'receipt', 'other'];

function buildSourceBreakdownParts(sourceMix: FinanceSourceMix) {
  return KIND_ORDER.filter((kind) => sourceMix.mix[kind] > 0)
    .map((kind) => `${KIND_LABELS[kind].toLowerCase()} ${sourceMix.mix[kind]}`);
}

export function classifyFinanceSource(source?: string | null): { kind: SourceKind; label: string } {
  const normalized = String(source || 'MANUAL').trim().toUpperCase();
  if (SAMPLE_SOURCES.has(normalized)) return { kind: 'sample', label: KIND_LABELS.sample };
  if (STRIPE_SOURCES.has(normalized)) return { kind: 'stripe', label: KIND_LABELS.stripe };
  if (BANK_SOURCES.has(normalized)) return { kind: 'bank', label: KIND_LABELS.bank };
  if (normalized === 'MANUAL') return { kind: 'manual', label: KIND_LABELS.manual };
  if (normalized === 'QBO_IMPORT' || normalized === 'QBO') return { kind: 'qbo', label: KIND_LABELS.qbo };
  if (normalized === 'RECEIPT' || normalized === 'RECEIPT_OCR') return { kind: 'receipt', label: KIND_LABELS.receipt };
  return { kind: 'other', label: source ? String(source) : KIND_LABELS.other };
}

export function sourceBadgeClass(kind: SourceKind): string {
  switch (kind) {
    case 'sample':
      return 'bg-amber-100 text-amber-900 border-amber-300';
    case 'stripe':
      return 'bg-violet-100 text-violet-900 border-violet-300';
    case 'bank':
      return 'bg-sky-100 text-sky-900 border-sky-300';
    case 'manual':
      return 'bg-slate-100 text-slate-700 border-slate-300';
    case 'qbo':
      return 'bg-emerald-100 text-emerald-900 border-emerald-300';
    case 'receipt':
      return 'bg-indigo-100 text-indigo-900 border-indigo-300';
    default:
      return 'bg-slate-100 text-slate-700 border-slate-300';
  }
}

export function buildFinanceSourceMix(items: FinanceSourceLike[]): FinanceSourceMix {
  const mix: Record<SourceKind, number> = {
    sample: 0,
    stripe: 0,
    bank: 0,
    manual: 0,
    qbo: 0,
    receipt: 0,
    other: 0,
  };

  for (const item of items) {
    mix[classifyFinanceSource(item.source).kind] += 1;
  }

  const total = items.length;
  const hasSample = mix.sample > 0;
  const hasLive = mix.stripe + mix.bank + mix.manual + mix.qbo + mix.receipt + mix.other > 0;
  const samplePct = total > 0 ? Math.round((mix.sample / total) * 100) : 0;
  const livePct = total > 0 ? Math.max(0, 100 - samplePct) : 0;

  if (total === 0) {
    return {
      total,
      mix,
      hasSample,
      hasLive,
      samplePct,
      livePct,
      headline: 'No finance source data is in view yet',
      tone: 'slate',
    };
  }

  if (hasSample && hasLive) {
    return {
      total,
      mix,
      hasSample,
      hasLive,
      samplePct,
      livePct,
      headline: `Mixed provenance view — ${samplePct}% sample, ${livePct}% live`,
      tone: 'amber',
    };
  }

  if (hasSample) {
    return {
      total,
      mix,
      hasSample,
      hasLive,
      samplePct,
      livePct,
      headline: 'Viewing sample finance data only',
      tone: 'amber',
    };
  }

  return {
    total,
    mix,
    hasSample,
    hasLive,
    samplePct,
    livePct,
    headline: 'Viewing live finance data',
    tone: 'emerald',
  };
}

export function buildFinanceSourceBreakdown(sourceMix: FinanceSourceMix): string {
  return buildSourceBreakdownParts(sourceMix).join(' · ');
}

export function buildFinanceSourceFilename(baseFilename: string, sourceMix: FinanceSourceMix): string {
  const dotIndex = baseFilename.lastIndexOf('.');
  const stem = dotIndex >= 0 ? baseFilename.slice(0, dotIndex) : baseFilename;
  const extension = dotIndex >= 0 ? baseFilename.slice(dotIndex) : '';
  const suffix = sourceMix.total === 0
    ? 'no-source-data'
    : sourceMix.hasSample && sourceMix.hasLive
    ? `mixed-${sourceMix.samplePct}pct-sample`
    : sourceMix.hasSample
    ? 'sample-only'
    : 'live-only';

  return `${stem}-${suffix}${extension}`;
}

function bannerToneClass(tone: FinanceSourceMix['tone']): string {
  switch (tone) {
    case 'amber':
      return 'border-amber-300 bg-amber-50 text-amber-950';
    case 'emerald':
      return 'border-emerald-200 bg-emerald-50 text-emerald-950';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-800';
  }
}

export function SourceBadge({ source, className = '' }: { source?: string | null; className?: string }) {
  const { kind, label } = classifyFinanceSource(source);
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${sourceBadgeClass(kind)} ${className}`.trim()}
      title={`Source: ${source || 'unknown'}`}
    >
      {label}
    </span>
  );
}

export function FinanceSourceTruthBanner({
  sourceMix,
  scopeLabel,
  note,
  actions,
  compact = false,
}: {
  sourceMix: FinanceSourceMix;
  scopeLabel?: string;
  note?: string;
  actions?: React.ReactNode;
  compact?: boolean;
}) {
  const breakdown = buildFinanceSourceBreakdown(sourceMix);

  return (
    <div className={`rounded-xl border px-4 py-3 ${bannerToneClass(sourceMix.tone)}`}>
      <div className={`flex flex-wrap items-start justify-between gap-3 ${compact ? '' : 'sm:items-center'}`}>
        <div>
          <div className="font-semibold">{sourceMix.headline}</div>
          <div className="mt-1 text-xs opacity-80">
            {scopeLabel ? `${scopeLabel} · ` : ''}
            {sourceMix.total} entries in scope
            {breakdown ? ` · ${breakdown}` : ''}
          </div>
          {note && <div className="mt-2 text-xs opacity-80">{note}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}