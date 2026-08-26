/**
 * Turns building permits into dated component records.
 *
 * A permit is the strongest install date available without someone physically
 * looking at the unit: it is a government record with a date attached, and a
 * "reroof" permit from 2019 beats any vintage guess about the roof. Permits
 * therefore override inferred records but never owner- or service-confirmed ones.
 */

import type { BuildingPermit } from '../types/attom';
import {
  createEmptyHealthAsset,
  isHigherEvidence,
  type PropertyHealthAsset,
  type PropertyHealthCategory,
} from '../types/propertyHealth';

interface PermitRule {
  category: PropertyHealthCategory;
  name: string;
  /** Matched against permit type and work description, lowercased. */
  patterns: RegExp;
  /** Reject matches that are really about something else. */
  exclude?: RegExp;
  confidence: number;
}

/*
 * Ordered most specific first. A "water heater replacement" permit should land on
 * water_heater, not on the broader plumbing rule.
 */
const PERMIT_RULES: PermitRule[] = [
  {
    category: 'water_heater',
    name: 'Water heater',
    patterns: /\b(water\s*heater|hot\s*water\s*(tank|heater)|tankless)\b/,
    confidence: 0.9,
  },
  {
    category: 'roof',
    name: 'Roof',
    patterns: /\b(re-?roof|roofing|roof\s*(replacement|repair|covering)|shingle|tear\s*off)\b/,
    confidence: 0.9,
  },
  {
    category: 'hvac',
    name: 'HVAC system',
    patterns: /\b(hvac|furnace|air\s*condition\w*|heat\s*pump|a\/c|mini\s*split|air\s*handler|condenser|mechanical)\b/,
    confidence: 0.85,
  },
  {
    category: 'electrical',
    name: 'Electrical panel',
    patterns: /\b(electric\w*|panel\s*(upgrade|replacement)|service\s*upgrade|rewire|amp\s*service|ev\s*charger)\b/,
    confidence: 0.8,
  },
  {
    category: 'windows',
    name: 'Windows',
    patterns: /\b(window|glazing|fenestration)\b/,
    exclude: /\bwindow\s*well\b/,
    confidence: 0.85,
  },
  {
    category: 'plumbing',
    name: 'Plumbing',
    patterns: /\b(plumb\w*|repipe|re-?pipe|sewer|water\s*service|supply\s*line)\b/,
    confidence: 0.8,
  },
  {
    category: 'exterior',
    name: 'Exterior',
    patterns: /\b(siding|deck|gutter|driveway|stucco|facade)\b/,
    confidence: 0.75,
  },
];

function permitText(permit: BuildingPermit): string {
  return [permit.permit_type, permit.permit_type_description, permit.work_description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function permitDate(permit: BuildingPermit): string | null {
  if (!permit.issue_date) return null;
  const date = new Date(permit.issue_date);
  if (Number.isNaN(date.getTime())) return null;
  // Reject obviously bogus dates rather than writing them into the inventory.
  const year = date.getUTCFullYear();
  if (year < 1900 || year > new Date().getUTCFullYear() + 1) return null;
  return date.toISOString().slice(0, 10);
}

export function classifyPermit(permit: BuildingPermit): PermitRule | null {
  const text = permitText(permit);
  if (!text.trim()) return null;
  return (
    PERMIT_RULES.find(
      (rule) => rule.patterns.test(text) && !(rule.exclude && rule.exclude.test(text)),
    ) ?? null
  );
}

/**
 * Builds one record per category from the most recent dated permit that matched
 * it. Older permits for the same system are history, not current state, and
 * belong on the timeline rather than the inventory.
 */
export function buildAssetsFromPermits(permits: BuildingPermit[]): PropertyHealthAsset[] {
  const bestByCategory = new Map<PropertyHealthCategory, { permit: BuildingPermit; rule: PermitRule; date: string }>();

  for (const permit of permits) {
    const rule = classifyPermit(permit);
    if (!rule) continue;
    const date = permitDate(permit);
    if (!date) continue;

    const existing = bestByCategory.get(rule.category);
    if (!existing || date > existing.date) {
      bestByCategory.set(rule.category, { permit, rule, date });
    }
  }

  return Array.from(bestByCategory.values()).map(({ permit, rule, date }) => {
    const descriptor = permit.work_description || permit.permit_type_description || permit.permit_type;
    return createEmptyHealthAsset({
      id: `permit_${rule.category}`,
      category: rule.category,
      name: rule.name,
      installedAt: date,
      source: 'permit',
      evidence: 'permit',
      priorKey: rule.category,
      notes: descriptor ? `From permit: ${descriptor}` : '',
      provenance: {
        existence: {
          evidence: 'permit',
          confidence: rule.confidence,
          rationale: `A permit issued ${date} covers ${rule.name.toLowerCase()} work at this address.`,
          sourceRef: permit.permit_number,
          observedAt: new Date().toISOString(),
        },
        installedAt: {
          evidence: 'permit',
          confidence: rule.confidence,
          rationale: `Permit issue date ${date}${permit.permit_number ? ` (#${permit.permit_number})` : ''}.`,
          sourceRef: permit.permit_number,
          observedAt: new Date().toISOString(),
        },
      },
    });
  });
}

/**
 * Layers permit-derived records over an existing list. Permits replace inferred
 * guesses in the same category and are skipped where the owner or a technician
 * already supplied something stronger.
 */
export function mergePermitAssets(
  existing: PropertyHealthAsset[],
  permitAssets: PropertyHealthAsset[],
): PropertyHealthAsset[] {
  const result = [...existing];

  for (const permitAsset of permitAssets) {
    const index = result.findIndex((asset) => asset.category === permitAsset.category);

    if (index < 0) {
      result.push(permitAsset);
      continue;
    }

    const current = result[index];
    if (isHigherEvidence('permit', current.evidence ?? 'owner')) {
      // Carry the record's identity forward so any linked spend stays attached.
      result[index] = {
        ...permitAsset,
        id: current.id,
        createdAt: current.createdAt,
        name: current.name || permitAsset.name,
      };
    }
  }

  return result;
}
