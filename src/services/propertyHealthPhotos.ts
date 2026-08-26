import {
  HEALTH_EVIDENCE_RANK,
  type FieldProvenance,
  type PropertyHealthAsset,
  type PropertyHealthAttachment,
  type PropertyHealthCategory,
  type ProvenancedField,
} from '../types/propertyHealth';

export interface HealthPhotoObservation {
  label: string;
  severity: 'info' | 'watch' | 'warning' | 'critical';
  evidence: string;
}

export interface HealthPhotoAnalysis {
  componentPresent: boolean;
  category: PropertyHealthCategory;
  name?: string | null;
  make?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  /** Explicit manufacture/data-plate date; never treated as install date. */
  manufactureDate?: string | null;
  conditionScore?: number | null;
  urgency: 'routine' | 'monitor' | 'soon' | 'urgent';
  summary?: string | null;
  observations: HealthPhotoObservation[];
  wearSigns: string[];
  failureSigns: string[];
  recommendedActions: string[];
  ocrText?: string | null;
  limitations: string[];
  confidence: number;
  modelIdentityReady: boolean;
}

export interface HealthPhotoAnalysisResult {
  ok: boolean;
  status: string;
  error?: string;
  analysis: HealthPhotoAnalysis | null;
}

function currentEvidence(asset: PropertyHealthAsset, field: ProvenancedField) {
  return asset.provenance?.[field]?.evidence ?? asset.evidence ?? 'owner';
}

function canApplyPhotoField(
  asset: PropertyHealthAsset,
  field: ProvenancedField,
  currentValue: unknown,
): boolean {
  if (currentValue == null || currentValue === '') return true;
  return HEALTH_EVIDENCE_RANK.photo > HEALTH_EVIDENCE_RANK[currentEvidence(asset, field)];
}

function photoProvenance(
  analysis: HealthPhotoAnalysis,
  attachment: PropertyHealthAttachment,
  observedAt: string,
): FieldProvenance {
  return {
    evidence: 'photo',
    confidence: analysis.confidence,
    rationale: 'Read from an owner-reviewed component photo.',
    sourceRef: attachment.id,
    observedAt,
  };
}

/**
 * Applies only the fields a photo can prove.
 *
 * Manufacture date is intentionally omitted. A unit manufactured in 2018 might
 * have sat in distribution until 2020; using the plate date as installation would
 * create false precision in every forecast. It remains visible in the photo result
 * and can be copied into notes after owner confirmation.
 */
export function applyHealthPhotoAnalysis(
  asset: PropertyHealthAsset,
  analysis: HealthPhotoAnalysis,
  attachment: PropertyHealthAttachment,
  now = new Date(),
): PropertyHealthAsset {
  const observedAt = now.toISOString();
  const provenance = { ...asset.provenance };
  const next = {
    ...asset,
    attachments: [
      ...(asset.attachments ?? []).filter((item) => item.id !== attachment.id),
      attachment,
    ],
    visualCondition: analysis.conditionScore == null
      ? asset.visualCondition ?? null
      : {
          score: Math.min(100, Math.max(0, analysis.conditionScore)),
          observedAt,
          summary: analysis.summary || undefined,
          observations: analysis.observations,
          wearSigns: analysis.wearSigns,
          failureSigns: analysis.failureSigns,
          recommendedActions: analysis.recommendedActions,
          limitations: analysis.limitations,
          confidence: analysis.confidence,
          attachmentId: attachment.id,
        },
    updatedAt: observedAt,
  };

  const apply = (
    field: 'make' | 'model' | 'serialNumber',
    value: string | null | undefined,
  ) => {
    if (!value || !canApplyPhotoField(asset, field, asset[field])) return;
    next[field] = value;
    provenance[field] = photoProvenance(analysis, attachment, observedAt);
  };
  apply('make', analysis.make);
  apply('model', analysis.model);
  apply('serialNumber', analysis.serialNumber);

  return {
    ...next,
    provenance,
  };
}
