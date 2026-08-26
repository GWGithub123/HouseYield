import { Clock, DollarSign, ExternalLink, MapPin, Phone, RotateCcw, Star, TrendingUp, Wrench } from 'lucide-react';
import type { NetworkProvider } from '../../services/providerNetworkApi';

function scoreTone(score?: number | null) {
  if (score === null || score === undefined) return 'border-slate-200 bg-slate-50 text-slate-600';
  if (score >= 80) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (score >= 60) return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-rose-200 bg-rose-50 text-rose-700';
}

function money(value?: number | null) {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function Stat({ icon: Icon, label, value }: { icon: typeof Clock; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2.5">
      <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number | string | null | undefined }) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;

  // The AI returns these on a 1–10 scale.
  const percent = Math.max(0, Math.min(100, numeric * 10));

  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-600">{label}</span>
        <span className="font-medium text-slate-900">{numeric}/10</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

interface ProviderAnalysisPanelProps {
  provider: NetworkProvider | null;
  providerCount: number;
}

/**
 * The right rail of the provider network view: HouseYield's own outcome data first,
 * then the AI review analysis that got them shortlisted.
 */
export default function ProviderAnalysisPanel({ provider, providerCount }: ProviderAnalysisPanelProps) {
  if (!provider) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-4 py-10 text-center">
        <MapPin className="h-8 w-8 text-slate-300" />
        <div className="mt-3 text-sm font-medium text-slate-700">
          {providerCount ? 'Select a provider' : 'No providers yet'}
        </div>
        <p className="mt-1 max-w-[220px] text-xs leading-relaxed text-slate-500">
          {providerCount
            ? 'Click any pin to see its AI review analysis and how it has performed on HouseYield jobs.'
            : 'Providers appear here as soon as the AI runs its first search for one of your tickets.'}
        </p>
      </div>
    );
  }

  const stats = provider.networkStats;
  const analysis = provider.aiAnalysis;
  const score = provider.aiScore ?? analysis?.overallScore ?? null;

  return (
    <div className="space-y-4 overflow-y-auto p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 text-base font-semibold leading-snug text-slate-900">{provider.name}</h3>
          {score !== null && (
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${scoreTone(score)}`}>
              {Math.round(Number(score))}
            </span>
          )}
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          {provider.rating !== null && provider.rating !== undefined && (
            <span className="inline-flex items-center gap-1">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              {provider.rating}
              {provider.reviewCount ? ` (${provider.reviewCount})` : ''}
            </span>
          )}
          {provider.distanceMiles !== null && provider.distanceMiles !== undefined && (
            <span>{provider.distanceMiles} mi away</span>
          )}
        </div>

        {provider.address && (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-slate-500">
            <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{provider.address}</span>
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap gap-2">
          {provider.phone && (
            <a
              href={`tel:${provider.phone}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100"
            >
              <Phone className="h-3 w-3" /> {provider.phone}
            </a>
          )}
          {provider.website && (
            <a
              href={provider.website}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              <ExternalLink className="h-3 w-3" /> Website
            </a>
          )}
        </div>

        {provider.categories?.length ? (
          <div className="mt-2.5 flex flex-wrap gap-1">
            {provider.categories.slice(0, 6).map((category) => (
              <span key={category} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium capitalize text-slate-600">
                {category}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* HouseYield's own track record comes before the third-party reviews. */}
      <div className="border-t border-slate-200 pt-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
          HouseYield track record
        </div>
        {stats && stats.jobsCompleted > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <Stat icon={Wrench} label="Jobs" value={String(stats.jobsCompleted)} />
            <Stat icon={DollarSign} label="Avg cost" value={money(stats.avgCost)} />
            <Stat
              icon={TrendingUp}
              label="First-visit fix"
              value={stats.firstVisitResolutionRate !== null ? `${stats.firstVisitResolutionRate}%` : '—'}
            />
            <Stat
              icon={RotateCcw}
              label="Repeat rate"
              value={stats.repeatIssueRate !== null ? `${stats.repeatIssueRate}%` : '—'}
            />
            {stats.avgResponseHours !== null && (
              <Stat icon={Clock} label="Avg turnaround" value={`${stats.avgResponseHours}h`} />
            )}
            {stats.avgOwnerRating !== null && (
              <Stat icon={Star} label="Owner rating" value={`${stats.avgOwnerRating}/5`} />
            )}
          </div>
        ) : (
          <p className="text-xs leading-relaxed text-slate-500">
            No completed jobs yet. Once this provider finishes a visit, the parts they used, the cost, and whether
            the fix held will start building their record here.
          </p>
        )}
      </div>

      {analysis && (
        <div className="border-t border-slate-200 pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">AI review analysis</span>
            {analysis.recommendationLevel && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium capitalize text-slate-600">
                {String(analysis.recommendationLevel).replace(/_/g, ' ')}
              </span>
            )}
          </div>

          {analysis.summary && (
            <p className="mb-3 text-xs leading-relaxed text-slate-600">{analysis.summary}</p>
          )}

          <div className="space-y-2">
            <ScoreBar label="Expertise match" value={analysis.expertiseMatch} />
            <ScoreBar label="Responsiveness" value={analysis.responsiveness} />
            <ScoreBar label="Quality of work" value={analysis.qualityOfWork} />
            <ScoreBar label="Professionalism" value={analysis.professionalism} />
            <ScoreBar label="Pricing fairness" value={analysis.pricingFairness} />
          </div>

          {analysis.strengths?.length ? (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">Strengths</div>
              <ul className="space-y-0.5">
                {analysis.strengths.slice(0, 4).map((item) => (
                  <li key={item} className="text-xs leading-relaxed text-slate-600">• {item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {analysis.redFlags?.length ? (
            <div className="mt-3">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600">Watch for</div>
              <ul className="space-y-0.5">
                {analysis.redFlags.slice(0, 4).map((item) => (
                  <li key={item} className="text-xs leading-relaxed text-slate-600">• {item}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
