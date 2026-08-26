import { Link } from 'react-router-dom';

interface LegacyFinanceNoticeProps {
  title: string;
  canonicalSurface: string;
  detail: string;
  canonicalHref?: string;
  actionLabel?: string;
  className?: string;
}

export default function LegacyFinanceNotice({
  title,
  canonicalSurface,
  detail,
  canonicalHref,
  actionLabel = 'Open canonical surface',
  className = '',
}: LegacyFinanceNoticeProps) {
  return (
    <div className={`rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 ${className}`.trim()}>
      <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-700">Harvest-only surface</div>
          <div className="mt-1 font-semibold">{title}</div>
          <div className="mt-1 text-amber-900">{detail}</div>
          {canonicalHref ? (
            <Link
              to={canonicalHref}
              className="mt-3 inline-flex rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
            >
              {actionLabel}
            </Link>
          ) : null}
        </div>
        <div className="text-xs font-medium text-amber-800 md:pl-4">Canonical surface: {canonicalSurface}</div>
      </div>
    </div>
  );
}
