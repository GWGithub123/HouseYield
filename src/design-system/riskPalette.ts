/**
 * Single risk color scale shared by the property twin, the environmental maps
 * and the hazard services.
 *
 * Before this existed each surface picked its own ramp — power used emerald for
 * "good" while weather used cyan, and freeze/mold/predictive each declared a
 * separate five-step ladder. Anything that renders a risk level should read
 * from here so the three zoom levels of the twin stay legible as one system.
 */

export type RiskTier = 'minimal' | 'low' | 'moderate' | 'high' | 'severe';

export const RISK_COLOR: Record<RiskTier, string> = {
  minimal: '#22c55e',
  low: '#84cc16',
  moderate: '#eab308',
  high: '#f97316',
  severe: '#ef4444',
};

export const RISK_LABEL: Record<RiskTier, string> = {
  minimal: 'Minimal',
  low: 'Low',
  moderate: 'Moderate',
  high: 'High',
  severe: 'Severe',
};

/** Translucent fill for tinting a surface (room, parcel, map cell) by risk. */
export function riskTint(tier: RiskTier, alpha = 0.16): string {
  return withAlpha(RISK_COLOR[tier], alpha);
}

/** 0-100 where higher is worse. */
export function riskTierFromScore(score: number): RiskTier {
  if (score >= 80) return 'severe';
  if (score >= 60) return 'high';
  if (score >= 40) return 'moderate';
  if (score >= 20) return 'low';
  return 'minimal';
}

/**
 * Flood depth ramp, in feet. Deliberately discrete rather than a smooth
 * gradient: the tiers are what carry meaning (insurance thresholds, damage
 * curve breakpoints), and hard edges are honest about the resolution of the
 * underlying elevation grid instead of implying sub-foot precision.
 */
export interface DepthTier {
  id: string;
  minFt: number;
  /** Open-ended for the deepest tier. */
  maxFt: number | null;
  label: string;
  color: string;
}

export const DEPTH_TIERS: DepthTier[] = [
  { id: 'd0', minFt: 0.1, maxFt: 0.5, label: '0 – 0.5 ft', color: '#bfdbfe' },
  { id: 'd1', minFt: 0.5, maxFt: 1, label: '0.5 – 1 ft', color: '#60a5fa' },
  { id: 'd2', minFt: 1, maxFt: 2, label: '1 – 2 ft', color: '#3b82f6' },
  { id: 'd3', minFt: 2, maxFt: 3, label: '2 – 3 ft', color: '#1d4ed8' },
  { id: 'd4', minFt: 3, maxFt: null, label: '3+ ft', color: '#1e3a8a' },
];

export function depthTierFor(depthFt: number): DepthTier | null {
  if (!Number.isFinite(depthFt) || depthFt < DEPTH_TIERS[0].minFt) return null;
  for (const tier of DEPTH_TIERS) {
    if (tier.maxFt == null || depthFt < tier.maxFt) return tier;
  }
  return DEPTH_TIERS[DEPTH_TIERS.length - 1];
}

export function depthColor(depthFt: number): string | null {
  return depthTierFor(depthFt)?.color ?? null;
}

/** Accepts #rgb, #rrggbb, or an existing rgb()/rgba() string. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  if (hex.startsWith('#')) {
    const body = hex.slice(1);
    const full = body.length === 3
      ? body.split('').map((c) => c + c).join('')
      : body;
    if (full.length !== 6) return hex;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

/**
 * Indoor comfort ramp for tinting rooms by temperature. Distinct from the risk
 * ramp on purpose — a warm room is not a hazard, and reusing the red-for-bad
 * scale here would cry wolf every summer afternoon.
 */
export function comfortTint(tempF: number | null | undefined, alpha = 0.2): string | null {
  if (tempF == null || !Number.isFinite(tempF)) return null;
  if (tempF <= 45) return withAlpha('#3b82f6', alpha);
  if (tempF <= 60) return withAlpha('#60a5fa', alpha);
  if (tempF <= 72) return withAlpha('#22d3ee', alpha * 0.7);
  if (tempF <= 78) return withAlpha('#a3e635', alpha * 0.7);
  if (tempF <= 85) return withAlpha('#fbbf24', alpha);
  return withAlpha('#f97316', alpha);
}
