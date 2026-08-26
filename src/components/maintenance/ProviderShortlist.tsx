import { ExternalLink, Phone, ShieldCheck, Star } from 'lucide-react';
import type { ProviderCandidate } from './ticketTypes';

function scoreTone(score?: number) {
  if (score === undefined || score === null) return 'border-slate-200 bg-slate-50 text-slate-600';
  if (score >= 80) return 'border-emerald-200 bg-emerald-50 text-emerald-700';
  if (score >= 60) return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-slate-200 bg-slate-50 text-slate-600';
}

interface ProviderShortlistProps {
  providers: ProviderCandidate[];
  selectedName?: string;
  /** Shows tap-to-call links and the selection affordance (operator console). */
  actionable?: boolean;
  onSelect?: (provider: ProviderCandidate) => void;
}

/** Ranked provider candidates with their AI scores — the dispatcher's decision list. */
export default function ProviderShortlist({
  providers,
  selectedName,
  actionable = false,
  onSelect,
}: ProviderShortlistProps) {
  if (!providers.length) {
    return (
      <p className="text-sm text-slate-500">
        No provider candidates have been captured for this ticket yet.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {providers.map((provider, index) => {
        const isSelected = Boolean(selectedName && provider.name === selectedName);
        const score = provider.aiScore ?? provider.reviewAnalysis?.overallScore;

        return (
          <li
            key={`${provider.placeId || provider.name}-${index}`}
            className={[
              'rounded-xl border p-3 transition',
              isSelected ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-white',
            ].join(' ')}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-slate-400">#{index + 1}</span>
                  <span className="truncate text-sm font-semibold text-slate-900">{provider.name}</span>
                  {provider.isTrusted && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                      <ShieldCheck className="h-3 w-3" /> Trusted
                    </span>
                  )}
                  {isSelected && (
                    <span className="rounded-full border border-emerald-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      Selected
                    </span>
                  )}
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                  {provider.rating !== undefined && (
                    <span className="inline-flex items-center gap-1">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                      {provider.rating}
                      {provider.reviewCount ? ` (${provider.reviewCount})` : ''}
                    </span>
                  )}
                  {provider.phone && (
                    actionable ? (
                      <a
                        href={`tel:${provider.phone}`}
                        className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline"
                      >
                        <Phone className="h-3 w-3" /> {provider.phone}
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Phone className="h-3 w-3" /> {provider.phone}
                      </span>
                    )
                  )}
                  {provider.website && actionable && (
                    <a
                      href={provider.website}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" /> Site
                    </a>
                  )}
                </div>

                {provider.address && (
                  <div className="mt-0.5 truncate text-xs text-slate-400">{provider.address}</div>
                )}

                {(provider.selectionReasoning || provider.reviewAnalysis?.summary) && (
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                    {provider.selectionReasoning || provider.reviewAnalysis?.summary}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 flex-col items-end gap-1.5">
                {score !== undefined && score !== null && (
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${scoreTone(Number(score))}`}>
                    {Math.round(Number(score))}
                  </span>
                )}
                {actionable && onSelect && !isSelected && (
                  <button
                    type="button"
                    onClick={() => onSelect(provider)}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-50"
                  >
                    Use this
                  </button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
