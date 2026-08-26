/**
 * formatters — the single formatting utility for currency, dates, percents,
 * and deltas. Every user-visible number on the platform goes through these so
 * the same value never renders three different ways.
 */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const USD_CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whole-dollar currency: `$62,200`. The default for KPI values and tables.
 * Returns the fallback (default '—') for null/undefined/NaN — never render
 * a fake $0 for missing data.
 */
export function formatCurrency(value: number | null | undefined, fallback = '—'): string {
  if (!isFiniteNumber(value)) return fallback;
  return USD.format(value);
}

/** Currency with cents: `$19,028.52`. For ledgers and statements. */
export function formatCurrencyExact(value: number | null | undefined, fallback = '—'): string {
  if (!isFiniteNumber(value)) return fallback;
  return USD_CENTS.format(value);
}

/**
 * Compact currency: `$3.3M`, `$62K`. For tight spaces (sidebar, chips,
 * chart axes) only — KPI strips use formatCurrency.
 */
export function formatCurrencyCompact(value: number | null | undefined, fallback = '—'): string {
  if (!isFiniteNumber(value)) return fallback;
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${trimTrailingZero((abs / 1_000_000_000).toFixed(1))}B`;
  if (abs >= 1_000_000) return `${sign}$${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`;
  if (abs >= 10_000) return `${sign}$${trimTrailingZero((abs / 1_000).toFixed(0))}K`;
  if (abs >= 1_000) return `${sign}$${trimTrailingZero((abs / 1_000).toFixed(1))}K`;
  return `${sign}$${NUMBER.format(abs)}`;
}

function trimTrailingZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}

/** Plain number with thousands separators: `1,058,693`. */
export function formatNumber(value: number | null | undefined, fallback = '—'): string {
  if (!isFiniteNumber(value)) return fallback;
  return NUMBER.format(value);
}

/**
 * Percent from a fraction or a percent value.
 * formatPercent(0.053) === '5.3%'; formatPercent(5.3, { input: 'percent' }) === '5.3%'.
 */
export function formatPercent(
  value: number | null | undefined,
  options: { input?: 'fraction' | 'percent'; decimals?: number; fallback?: string } = {},
): string {
  const { input = 'fraction', decimals = 1, fallback = '—' } = options;
  if (!isFiniteNumber(value)) return fallback;
  const percent = input === 'fraction' ? value * 100 : value;
  return `${trimTrailingZero(percent.toFixed(decimals))}%`;
}

/**
 * Signed delta with direction: `+$1,200`, `-4.7%`. For change-over-period
 * copy next to KPI values.
 */
export function formatDelta(
  value: number | null | undefined,
  options: { kind?: 'currency' | 'percent' | 'number'; decimals?: number; fallback?: string } = {},
): string {
  const { kind = 'number', decimals = 1, fallback = '—' } = options;
  if (!isFiniteNumber(value)) return fallback;
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (kind === 'currency') return `${sign}${USD.format(abs)}`;
  if (kind === 'percent') return `${sign}${trimTrailingZero(abs.toFixed(decimals))}%`;
  return `${sign}${NUMBER.format(abs)}`;
}

/** Medium date: `Jul 6, 2026`. The default for all user-visible dates. */
export function formatDate(value: Date | string | number | null | undefined, fallback = '—'): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Date + time: `Jul 6, 2026, 4:18 PM`. For logs and audit trails. */
export function formatDateTime(value: Date | string | number | null | undefined, fallback = '—'): string {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Relative freshness: `just now`, `3 min ago`, `2 hours ago`, `Jul 3`.
 * The standard "Updated …" treatment on data cards.
 */
export function formatRelativeTime(value: Date | string | number | null | undefined, fallback = '—'): string {
  const date = toDate(value);
  if (!date) return fallback;
  const deltaMs = Date.now() - date.getTime();
  if (deltaMs < 0) return formatDate(date);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
