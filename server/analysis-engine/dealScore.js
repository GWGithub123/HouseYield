/**
 * dealScore.js — single composite 0-100 deal score and plain-English verdict.
 *
 * Weighted components:
 *  - valuation edge (35): how far below fair value the price is
 *  - cash flow (30): year-1 monthly FCF and CoC of the best scenario
 *  - BRRRR equity capture (15): renovation value spread / cash recovered
 *  - market heat (10): county/zip momentum signals
 *  - risk & confidence (10): environmental risk penalty + data confidence
 */

function num(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function scaleTo(value, fromLow, fromHigh, toLow = 0, toHigh = 1) {
  if (!Number.isFinite(value)) return null;
  const t = clamp((value - fromLow) / (fromHigh - fromLow), 0, 1);
  return toLow + t * (toHigh - toLow);
}

export function computeDealScore({ valuation, scenarios, marketContext, environmentalRiskScore = null, confidence = 'medium' }) {
  const parts = [];

  // 1. Valuation edge (35 pts): -10% (overpriced) -> 0, +15% under -> full
  const variancePct = num(valuation?.variancePct);
  const valuationScore = variancePct != null ? scaleTo(variancePct, -10, 15) : 0.4;
  parts.push({ key: 'valuationEdge', weight: 35, score: valuationScore, detail: variancePct != null ? `${variancePct > 0 ? '+' : ''}${variancePct}% vs fair value` : 'no list price' });

  // 2. Cash flow (30 pts): blend monthly FCF (-200 -> +500) and CoC (0 -> 12%)
  const best = (scenarios || []).reduce((acc, s) => {
    const cf = num(s.summary?.monthlyCashFlowYear1) ?? -Infinity;
    return cf > (num(acc?.summary?.monthlyCashFlowYear1) ?? -Infinity) ? s : acc;
  }, null);
  const monthlyCf = num(best?.summary?.monthlyCashFlowYear1);
  const coc = num(best?.summary?.cocYear1Pct);
  const cfScore = monthlyCf != null
    ? 0.6 * (scaleTo(monthlyCf, -200, 500) ?? 0) + 0.4 * (scaleTo(coc ?? 0, 0, 12) ?? 0)
    : 0.3;
  parts.push({ key: 'cashFlow', weight: 30, score: cfScore, detail: monthlyCf != null ? `$${Math.round(monthlyCf)}/mo (${best?.label})` : 'unknown' });

  // 3. BRRRR equity capture (15 pts): refi recovers cash + value spread
  const brrrr = (scenarios || []).find((s) => s.key === 'brrrr');
  let brrrrScore = 0.3;
  let brrrrDetail = 'no renovation modeled';
  if (brrrr) {
    const cashIn = num(brrrr.summary?.cashIn) || 1;
    const cashLeft = num(brrrr.summary?.cashLeftInDeal) ?? cashIn;
    const recoveryRatio = 1 - cashLeft / cashIn;
    brrrrScore = scaleTo(recoveryRatio, 0, 0.9) ?? 0.3;
    brrrrDetail = `${Math.round(recoveryRatio * 100)}% of cash recovered at refi`;
  }
  parts.push({ key: 'brrrrEquity', weight: 15, score: brrrrScore, detail: brrrrDetail });

  // 4. Market heat (10 pts)
  let marketScore = 0.5;
  let marketDetail = 'neutral';
  const grossYield = num(marketContext?.grossYieldPct);
  const domSale = num(marketContext?.saleMedianDaysOnMarket);
  if (grossYield != null || domSale != null) {
    const yieldScore = grossYield != null ? scaleTo(grossYield, 4, 10) : 0.5;
    const domScore = domSale != null ? scaleTo(120 - domSale, 0, 100) : 0.5;
    marketScore = 0.6 * (yieldScore ?? 0.5) + 0.4 * (domScore ?? 0.5);
    marketDetail = `${grossYield != null ? `${grossYield}% gross yield` : ''}${domSale != null ? ` ${domSale}d DOM` : ''}`.trim();
  }
  parts.push({ key: 'marketHeat', weight: 10, score: marketScore, detail: marketDetail });

  // 5. Risk & confidence (10 pts)
  const confScore = confidence === 'high' ? 1 : confidence === 'medium' ? 0.6 : 0.25;
  const envPenalty = num(environmentalRiskScore) != null ? scaleTo(100 - num(environmentalRiskScore), 0, 100) : 0.7;
  const riskScore = 0.5 * confScore + 0.5 * (envPenalty ?? 0.7);
  parts.push({ key: 'riskConfidence', weight: 10, score: riskScore, detail: `${confidence} confidence${num(environmentalRiskScore) != null ? `, env risk ${Math.round(num(environmentalRiskScore))}/100` : ''}` });

  const total = Math.round(parts.reduce((sum, p) => sum + p.weight * clamp(p.score ?? 0, 0, 1), 0));

  // Verdict
  let grade;
  if (total >= 80) grade = 'A';
  else if (total >= 65) grade = 'B';
  else if (total >= 50) grade = 'C';
  else if (total >= 35) grade = 'D';
  else grade = 'F';

  const signals = [];
  if (valuation?.signal === 'undervalued') signals.push('Undervalued');
  else if (valuation?.signal === 'overvalued') signals.push('Overpriced');
  if (brrrr && num(brrrr.summary?.cashLeftInDeal) != null && num(brrrr.summary?.cashIn) != null
      && num(brrrr.summary.cashLeftInDeal) < num(brrrr.summary.cashIn) * 0.4) {
    signals.push('BRRRR candidate');
  }
  if (monthlyCf != null && monthlyCf > 0) signals.push('Cash-flow positive');
  else if (monthlyCf != null) signals.push('Negative cash flow');

  return {
    score: total,
    grade,
    signals,
    headline: signals.length ? signals.join(' + ') : 'Mixed signals',
    parts: parts.map((p) => ({ key: p.key, weight: p.weight, points: Math.round(p.weight * clamp(p.score ?? 0, 0, 1)), detail: p.detail })),
  };
}
