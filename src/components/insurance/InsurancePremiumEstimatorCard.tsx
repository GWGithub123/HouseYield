import React, { useMemo } from 'react';
import { DollarSign, Shield, TrendingDown } from 'lucide-react';
import type { InsurancePremiumEstimate } from '../../types/iot';

function formatCurrency(value?: number | null) {
  if (value == null || Number.isNaN(value)) return '—';
  return `$${Math.round(value).toLocaleString()}`;
}

interface InsurancePremiumEstimatorCardProps {
  estimate: InsurancePremiumEstimate | null;
  compact?: boolean;
  title?: string;
}

export default function InsurancePremiumEstimatorCard({
  estimate,
  compact = false,
  title = 'Insurance premium & mitigation savings',
}: InsurancePremiumEstimatorCardProps) {
  const typical = estimate?.mitigationCredit?.typical;
  const pitch = estimate?.recommendedPitch;

  const summaryLine = useMemo(() => {
    if (!typical?.monthlySavings) return null;
    return `Illustrative 10% sensitivity: ${formatCurrency(typical.monthlySavings)}/mo (${formatCurrency(typical.annualSavings)}/yr)`;
  }, [typical]);

  if (!estimate) {
    return null;
  }

  if (compact) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        <div className="flex items-center gap-2 font-medium">
          <Shield className="h-4 w-4" />
          Est. premium {formatCurrency(estimate.estimatedAnnualPremium)}/yr
        </div>
        {typical && (
          <div className="mt-1 text-emerald-800">
            10% sensitivity {formatCurrency(typical.monthlySavings)}/mo
            {pitch?.netMonthlyAfterMonitoring != null && (
              <span className="text-emerald-700">
                {' '}· net {formatCurrency(pitch.netMonthlyAfterMonitoring)}/mo after monitoring
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-blue-50 p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-white p-2 shadow-sm">
          <Shield className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="flex-1">
          <h4 className="font-semibold text-gray-900">{title}</h4>
          {summaryLine && <p className="mt-1 text-sm text-emerald-800">{summaryLine}</p>}
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="rounded-lg bg-white/80 p-3 border border-white">
          <div className="text-xs uppercase tracking-wide text-gray-500">Estimated premium</div>
          <div className="mt-1 text-xl font-bold text-gray-900">{formatCurrency(estimate.estimatedAnnualPremium)}</div>
          <div className="text-sm text-gray-600">{formatCurrency(estimate.estimatedMonthlyPremium)}/month</div>
          <div className="mt-1 text-xs text-gray-500">
            Range {formatCurrency(estimate.premiumRange.low)}–{formatCurrency(estimate.premiumRange.high)}/yr
          </div>
        </div>

        <div className="rounded-lg bg-white/80 p-3 border border-white">
          <div className="flex items-center gap-1 text-xs uppercase tracking-wide text-gray-500">
            <TrendingDown className="h-3 w-3" />
            Credit sensitivity
          </div>
          <div className="mt-1 text-xl font-bold text-emerald-700">
            {formatCurrency(typical?.monthlySavings)}/mo
          </div>
          <div className="text-sm text-gray-600">{formatCurrency(typical?.annualSavings)}/year at 10%</div>
          <div className="mt-1 text-xs text-gray-500">
            5% case {formatCurrency(estimate.mitigationCredit.conservative.monthlySavings)}/mo ·
            15% case {formatCurrency(estimate.mitigationCredit.optimistic.monthlySavings)}/mo
          </div>
        </div>

        <div className="rounded-lg bg-white/80 p-3 border border-white">
          <div className="flex items-center gap-1 text-xs uppercase tracking-wide text-gray-500">
            <DollarSign className="h-3 w-3" />
            Net after monitoring
          </div>
          <div className="mt-1 text-xl font-bold text-blue-700">
            {formatCurrency(pitch?.netMonthlyAfterMonitoring)}/mo
          </div>
          <div className="text-sm text-gray-600">{formatCurrency(pitch?.netAnnualAfterMonitoring)}/year</div>
          <div className="mt-1 text-xs text-gray-500">
            Assumes {formatCurrency(estimate.houseYieldCosts.monitoringMonthly)}/mo platform monitoring
          </div>
        </div>
      </div>

      {estimate.insurer && (
        <div className="mt-3 rounded-lg border border-blue-100 bg-white/70 px-3 py-2 text-sm text-gray-700">
          <strong>{estimate.insurer.name}</strong>: {estimate.insurer.publishedDiscount}. Program reference:{' '}
          {estimate.insurer.programName}. Confirm eligibility with the carrier.
        </div>
      )}

      <p className="mt-3 text-xs text-gray-500">{estimate.disclaimer}</p>
    </div>
  );
}
