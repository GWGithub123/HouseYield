import React, { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { previewWeeklyDigest, type WeeklyDigest } from '../../services/weeklyDigestClient';

const CACHE_KEY = 'hy-weekly-recap-preview-v3-real-estate';
const CACHE_TTL_MS = 30 * 60 * 1000;

const PERSONAL_FINANCE_PATTERN = /\b(net worth|stock portfolio|stock holdings?|equities|asml|portfolio allocation|dividend|ticker|brokerage|etf|mutual fund|securities|stock market)\b/i;

function isPersonalFinanceProse(text: string): boolean {
  return PERSONAL_FINANCE_PATTERN.test(text);
}

function filterRealEstateBullets(lines: string[]): string[] {
  return lines.filter((line) => !isPersonalFinanceProse(line));
}

function readCachedDigest(): WeeklyDigest | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; digest: WeeklyDigest };
    if (!parsed?.digest || Date.now() - parsed.savedAt > CACHE_TTL_MS) return null;
    return parsed.digest;
  } catch {
    return null;
  }
}

function writeCachedDigest(digest: WeeklyDigest) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), digest }));
  } catch {
    // Session storage full or unavailable — recap simply refetches next time.
  }
}

function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const formatted = abs >= 1000
    ? `$${(abs / 1000).toFixed(abs >= 100000 ? 0 : 1)}k`
    : `$${Math.round(abs).toLocaleString()}`;
  return value < 0 ? `-${formatted}` : formatted;
}

/**
 * Shared hook so the landing card and any fluid-UI surface render the exact
 * same digest data the Sunday email uses.
 */
export function useWeeklyRecapDigest(enabled: boolean) {
  const [digest, setDigest] = useState<WeeklyDigest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let isActive = true;
    const cached = readCachedDigest();
    if (cached) {
      setDigest(cached);
    }

    setLoading(!cached);
    previewWeeklyDigest()
      .then((next) => {
        if (!isActive) return;
        setDigest(next);
        writeCachedDigest(next);
        setError(null);
      })
      .catch((loadError: Error) => {
        if (!isActive) return;
        if (!cached) {
          setError(loadError.message);
        }
      })
      .finally(() => {
        if (isActive) setLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, [enabled]);

  return { digest, loading, error };
}

type RecapSlide = {
  id: string;
  title: string;
  body: React.ReactNode;
};

function KpiTile({ label, value, tone, dark }: { label: string; value: string; tone: 'ok' | 'warn' | 'neutral'; dark: boolean }) {
  const toneColor = tone === 'warn' ? '#f59e0b' : tone === 'ok' ? '#10b981' : dark ? '#94a3b8' : '#64748b';
  return (
    <div className={`min-w-0 rounded-xl border p-2.5 ${dark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50/60'}`}>
      <div className={`text-[9px] font-semibold uppercase tracking-[0.14em] ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</div>
      <div className="mt-1 truncate text-base font-semibold tracking-tight" style={{ color: toneColor }}>{value}</div>
    </div>
  );
}

function buildRecapSlides(digest: WeeklyDigest, dark: boolean): RecapSlide[] {
  const textSecondary = dark ? 'text-slate-300/90' : 'text-slate-600';
  const textMuted = dark ? 'text-slate-400' : 'text-slate-500';
  const narrative = digest.narrative;
  const financialWeek = digest.financialWeek?.available ? digest.financialWeek : null;
  const propertyValue = digest.propertyValue?.available ? digest.propertyValue : null;
  const activity = digest.managementActivity?.ok ? digest.managementActivity : null;
  const leases = digest.leases?.ok ? digest.leases : null;
  const slides: RecapSlide[] = [];

  const summarySentences = filterRealEstateBullets(
    String(narrative?.executiveSummary || '')
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter(Boolean),
  );

  if (summarySentences.length > 0) {
    slides.push({
      id: 'overview',
      title: 'Week at a glance',
      body: (
        <p className={`text-sm leading-6 ${textSecondary}`}>
          {summarySentences.slice(0, 3).join(' ')}
        </p>
      ),
    });
  }

  slides.push({
    id: 'money',
    title: 'Money this week',
    body: (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <KpiTile
            label="Rent collected"
            value={formatMoney(financialWeek?.rentCollected ?? activity?.collectedThisWeek ?? 0)}
            tone="ok"
            dark={dark}
          />
          <KpiTile
            label="Expenses"
            value={formatMoney(financialWeek?.totalExpenses ?? 0)}
            tone="neutral"
            dark={dark}
          />
          <KpiTile
            label="Net cash flow"
            value={formatMoney(financialWeek?.netCashFlow ?? 0)}
            tone={(financialWeek?.netCashFlow ?? 0) >= 0 ? 'ok' : 'warn'}
            dark={dark}
          />
          <KpiTile
            label="Other income"
            value={formatMoney(financialWeek?.otherIncome ?? 0)}
            tone="neutral"
            dark={dark}
          />
        </div>
        {narrative?.sectionInsights?.financialWeek ? (
          <p className={`text-sm leading-6 ${textSecondary}`}>{narrative.sectionInsights.financialWeek}</p>
        ) : null}
      </div>
    ),
  });

  slides.push({
    id: 'value',
    title: 'Property value',
    body: (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <KpiTile
            label="Portfolio value"
            value={formatMoney(propertyValue?.propertyValue ?? 0)}
            tone="neutral"
            dark={dark}
          />
          <KpiTile
            label="Week change"
            value={propertyValue?.weekChange != null ? formatMoney(propertyValue.weekChange) : '—'}
            tone={(propertyValue?.weekChange ?? 0) >= 0 ? 'ok' : 'warn'}
            dark={dark}
          />
        </div>
        {narrative?.sectionInsights?.propertyValue ? (
          <p className={`text-sm leading-6 ${textSecondary}`}>{narrative.sectionInsights.propertyValue}</p>
        ) : (
          <p className={`text-sm leading-6 ${textMuted}`}>Value updates appear here once AVM snapshots are on file.</p>
        )}
      </div>
    ),
  });

  if (leases?.expiringLeases?.length || leases?.newLeases?.length || narrative?.sectionInsights?.leases) {
    slides.push({
      id: 'leases',
      title: 'Leases & tenants',
      body: (
        <div className="space-y-3">
          {leases?.expiringLeases?.length ? (
            <ul className={`space-y-1.5 text-sm leading-6 ${textSecondary}`}>
              {leases.expiringLeases.map((lease, index) => (
                <li key={index}>
                  {lease.tenantName}{lease.address ? ` — ${lease.address}` : ''} expires in {lease.daysUntil} day{lease.daysUntil === 1 ? '' : 's'}
                </li>
              ))}
            </ul>
          ) : null}
          {narrative?.sectionInsights?.leases ? (
            <p className={`text-sm leading-6 ${textSecondary}`}>{narrative.sectionInsights.leases}</p>
          ) : null}
        </div>
      ),
    });
  }

  if (activity?.newMaintenanceRequests?.length || activity?.unreadMessageCount || narrative?.sectionInsights?.managementActivity) {
    slides.push({
      id: 'activity',
      title: 'Maintenance & messages',
      body: (
        <div className="space-y-3">
          {activity?.newMaintenanceRequests?.length ? (
            <ul className={`space-y-1.5 text-sm leading-6 ${textSecondary}`}>
              {activity.newMaintenanceRequests.slice(0, 4).map((request, index) => (
                <li key={index}>{request.title} ({request.status})</li>
              ))}
            </ul>
          ) : null}
          {activity?.unreadMessageCount ? (
            <p className={`text-sm ${textSecondary}`}>{activity.unreadMessageCount} unread tenant message{activity.unreadMessageCount === 1 ? '' : 's'} this week.</p>
          ) : null}
          {narrative?.sectionInsights?.managementActivity ? (
            <p className={`text-sm leading-6 ${textSecondary}`}>{narrative.sectionInsights.managementActivity}</p>
          ) : null}
        </div>
      ),
    });
  }

  const actionItems = filterRealEstateBullets(narrative?.actionItems || []);
  if (actionItems.length > 0) {
    slides.push({
      id: 'actions',
      title: 'Action items',
      body: (
        <ul className={`space-y-2 text-sm leading-6 ${textSecondary}`}>
          {actionItems.map((item, index) => (
            <li key={index} className="flex gap-2">
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dark ? 'bg-teal-300' : 'bg-teal-500'}`} />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ),
    });
  }

  return slides;
}

function RecapCarousel({
  slides,
  dark,
  compact,
}: {
  slides: RecapSlide[];
  dark: boolean;
  compact: boolean;
}) {
  const [index, setIndex] = useState(0);
  const total = slides.length;
  const current = slides[index] ?? slides[0];

  useEffect(() => {
    if (index >= total) {
      setIndex(Math.max(0, total - 1));
    }
  }, [index, total]);

  if (!current) return null;

  const textPrimary = dark ? 'text-white' : 'text-slate-900';
  const textMuted = dark ? 'text-slate-400' : 'text-slate-500';
  const railIdle = dark
    ? 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'
    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50';
  const railActive = dark
    ? 'border-teal-400/40 bg-teal-400/15 text-teal-100'
    : 'border-slate-900 bg-slate-900 text-white';

  return (
    <div className={`flex flex-col gap-3 ${compact ? 'h-full' : ''}`}>
      {!compact ? (
        <div className="flex flex-col gap-1.5">
          {slides.map((slide, slideIndex) => {
            const isActive = slideIndex === index;
            return (
              <button
                key={slide.id}
                type="button"
                onClick={() => setIndex(slideIndex)}
                className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                  isActive ? railActive : railIdle
                }`}
              >
                <span className="min-w-0">
                  <span className={`block text-[11px] font-semibold uppercase tracking-[0.14em] ${isActive ? (dark ? 'text-teal-200/80' : 'text-white/70') : textMuted}`}>
                    {slideIndex + 1} of {total}
                  </span>
                  <span className={`mt-0.5 block truncate text-sm font-semibold ${isActive ? '' : textPrimary}`}>
                    {slide.title}
                  </span>
                </span>
                {isActive ? <ChevronRight size={16} className="shrink-0 opacity-80" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className={`flex flex-col rounded-2xl border p-3.5 ${compact ? 'min-h-[300px] flex-1' : ''} ${dark ? 'border-white/10 bg-white/5' : 'border-slate-200 bg-slate-50/70'}`}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className={`text-sm font-semibold tracking-tight ${textPrimary}`}>{current.title}</div>
          {compact ? (
            <div className={`shrink-0 text-[11px] font-semibold uppercase tracking-[0.12em] ${textMuted}`}>
              {index + 1} of {total}
            </div>
          ) : null}
        </div>
        <div key={current.id} className={`opacity-100 transition-opacity duration-200 ${compact ? 'flex-1' : ''}`}>
          {current.body}
        </div>
        {compact && total > 1 ? (
          <div className="mt-3 flex items-center justify-center gap-1.5">
            {slides.map((slide, slideIndex) => (
              <button
                key={slide.id}
                type="button"
                aria-label={`Go to ${slide.title}`}
                onClick={() => setIndex(slideIndex)}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  slideIndex === index
                    ? (dark ? 'w-5 bg-teal-300' : 'w-5 bg-teal-600')
                    : (dark ? 'w-1.5 bg-white/20 hover:bg-white/40' : 'w-1.5 bg-slate-300 hover:bg-slate-400')
                }`}
              />
            ))}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            aria-label="Previous recap section"
            disabled={index === 0}
            onClick={() => setIndex((value) => Math.max(0, value - 1))}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-30 ${
              dark ? 'text-slate-300 hover:bg-white/10' : 'text-slate-600 hover:bg-white'
            }`}
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <button
            type="button"
            aria-label="Next recap section"
            disabled={index >= total - 1}
            onClick={() => setIndex((value) => Math.min(total - 1, value + 1))}
            className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition disabled:opacity-30 ${
              dark ? 'text-slate-300 hover:bg-white/10' : 'text-slate-600 hover:bg-white'
            }`}
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function YourWeekRecapCard({
  theme = 'light',
  enabled = true,
  variant = 'sidebar',
}: {
  theme?: 'light' | 'dark';
  enabled?: boolean;
  variant?: 'sidebar' | 'surface' | 'dashboard';
}) {
  const { digest, loading, error } = useWeeklyRecapDigest(enabled);
  const dark = theme === 'dark';
  const compact = variant === 'dashboard';

  const slides = useMemo(
    () => (digest ? buildRecapSlides(digest, dark) : []),
    [digest, dark],
  );

  const textPrimary = dark ? 'text-white' : 'text-slate-900';
  const textMuted = dark ? 'text-slate-400' : 'text-slate-500';

  return (
    <div className={variant === 'sidebar' ? '' : compact ? 'flex h-full flex-col p-1' : 'p-1'}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${textMuted}`}>Your week</div>
          <div className={`mt-0.5 text-base font-semibold tracking-tight ${textPrimary}`}>
            {digest?.window?.label || 'Weekly recap'}
          </div>
        </div>
        {loading ? (
          <div className={`h-4 w-4 shrink-0 animate-spin rounded-full border-2 ${dark ? 'border-white/20 border-t-white' : 'border-slate-300 border-t-slate-700'}`} />
        ) : null}
      </div>

      {loading && !digest ? (
        <div className={`mt-4 space-y-3 text-sm ${textMuted}`}>
          <div className={`h-3 w-[80%] rounded ${dark ? 'bg-white/10' : 'bg-slate-200'}`} />
          <div className={`h-3 w-full rounded ${dark ? 'bg-white/10' : 'bg-slate-200'}`} />
          <div className={`h-3 w-[60%] rounded ${dark ? 'bg-white/10' : 'bg-slate-200'}`} />
          <p className="pt-2 text-xs">Building your week in review…</p>
        </div>
      ) : error && !digest ? (
        <p className={`mt-4 text-sm ${textMuted}`}>Weekly recap unavailable right now. {error}</p>
      ) : digest && slides.length > 0 ? (
        <div className={compact ? 'mt-3 flex min-h-0 flex-1 flex-col' : 'mt-3'}>
          <RecapCarousel slides={slides} dark={dark} compact={compact} />
        </div>
      ) : digest ? (
        <p className={`mt-4 text-sm ${textMuted}`}>Your weekly recap is ready — narrative details are still generating.</p>
      ) : null}
    </div>
  );
}
