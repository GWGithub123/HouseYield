import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Upload, Trash2, Pencil, FileText, X, ShieldCheck, Check, AlertTriangle, Sparkles } from 'lucide-react';
import type { BuildingPermit } from '../../types/attom';
import {
  HEALTH_EVIDENCE_META,
  PROPERTY_HEALTH_CATEGORY_META,
  PROPERTY_HEALTH_QUICK_ADD,
  computePropertyHealthScore,
  createEmptyHealthAsset,
  formatAgeLabel,
  isUnconfirmedAsset,
  resolveAssetAgeYears,
  resolveAssetStatus,
  resolveLifeUsedRatio,
  resolveUsefulLifeYears,
  type HealthEvidence,
  type PropertyHealthAsset,
  type PropertyHealthAttachment,
  type PropertyHealthCategory,
  type PropertyHealthStatus,
} from '../../types/propertyHealth';
import { buildPropertyHealthPriors, mergePriorsWithSaved } from '../../services/propertyHealthPriors';
import { buildAssetsFromPermits, mergePermitAssets } from '../../services/propertyHealthPermits';
import { summarizeComponentCosts } from '../../services/propertyHealthDocuments';
import { buildPropertyHistoryTimeline } from '../../services/propertyHealthTimeline';
import {
  buildPropertyMaintenanceForecast,
  inferPropertyMaintenanceExposure,
  type ComponentModelProfile,
} from '../../services/propertyHealthForecast';
import ComponentCostLedger from './ComponentCostLedger';
import HealthDocumentIngest from './HealthDocumentIngest';
import HealthPhotoAnalysis from './HealthPhotoAnalysis';
import PropertyMaintenanceForecast from './PropertyMaintenanceForecast';
import PropertyHistoryTimeline from './PropertyHistoryTimeline';
import { ownerPropertiesClient } from '../../services/ownerPropertiesClient';
import { usePropertyHealthAssets } from '../../hooks/usePropertyHealthAssets';
import { uploadPropertyDocument } from '../../services/storageService';
import { Badge } from '../../design-system/components/Badge';
import { Button } from '../../design-system/components/Button';
import { Field, SelectInput } from '../../design-system/components/FormControls';
import { Modal } from '../../design-system/components/Modal';
import { TwinCard, TwinPill, TwinRailSection, TwinSegmented } from './TwinCard';

const HEALTH_CONTROL_CLASS =
  'ds-focus-ring h-10 w-full rounded-xl border border-slate-300 bg-white px-3.5 text-sm text-slate-900 placeholder:text-slate-400 transition hover:border-slate-400 focus:border-slate-500 focus:outline-none';
const HEALTH_TEXTAREA_CLASS =
  'ds-focus-ring w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 transition hover:border-slate-400 focus:border-slate-500 focus:outline-none';

const STATUS_META: Record<PropertyHealthStatus, { label: string; tone: 'success' | 'warn' | 'danger' | 'neutral' }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  monitor: { label: 'Monitor', tone: 'warn' },
  attention: { label: 'Replace soon', tone: 'danger' },
  unknown: { label: 'Age unknown', tone: 'neutral' },
};

type DraftAsset = {
  id?: string;
  category: PropertyHealthCategory;
  name: string;
  make: string;
  model: string;
  serialNumber: string;
  installedAt: string;
  estimatedAgeYears: string;
  usefulLifeYears: string;
  notes: string;
  attachments: PropertyHealthAttachment[];
};

const emptyDraft = (seed?: Partial<DraftAsset>): DraftAsset => ({
  category: seed?.category || 'hvac',
  name: seed?.name || '',
  make: seed?.make || '',
  model: seed?.model || '',
  serialNumber: seed?.serialNumber || '',
  installedAt: seed?.installedAt || '',
  estimatedAgeYears: seed?.estimatedAgeYears || '',
  usefulLifeYears:
    seed?.usefulLifeYears
    || String(PROPERTY_HEALTH_CATEGORY_META[seed?.category || 'hvac'].defaultUsefulLifeYears),
  notes: seed?.notes || '',
  attachments: seed?.attachments || [],
  id: seed?.id,
});

function draftFromAsset(asset: PropertyHealthAsset): DraftAsset {
  return emptyDraft({
    id: asset.id,
    category: asset.category,
    name: asset.name,
    make: asset.make || '',
    model: asset.model || '',
    serialNumber: asset.serialNumber || '',
    installedAt: asset.installedAt ? asset.installedAt.slice(0, 10) : '',
    estimatedAgeYears:
      typeof asset.estimatedAgeYears === 'number' ? String(asset.estimatedAgeYears) : '',
    usefulLifeYears: String(resolveUsefulLifeYears(asset)),
    notes: asset.notes || '',
    attachments: asset.attachments || [],
  });
}

function assetFromDraft(draft: DraftAsset): PropertyHealthAsset {
  const estimated = draft.estimatedAgeYears.trim()
    ? Number(draft.estimatedAgeYears)
    : null;
  const usefulLife = draft.usefulLifeYears.trim()
    ? Number(draft.usefulLifeYears)
    : PROPERTY_HEALTH_CATEGORY_META[draft.category].defaultUsefulLifeYears;

  const base = createEmptyHealthAsset({
    id: draft.id,
    category: draft.category,
    name: draft.name.trim() || PROPERTY_HEALTH_CATEGORY_META[draft.category].label,
    make: draft.make.trim(),
    model: draft.model.trim(),
    serialNumber: draft.serialNumber.trim(),
    installedAt: draft.installedAt || null,
    estimatedAgeYears: Number.isFinite(estimated as number) ? estimated : null,
    usefulLifeYears: Number.isFinite(usefulLife) ? usefulLife : null,
    notes: draft.notes.trim(),
    attachments: draft.attachments,
    source: 'manual',
  });

  if (draft.id) {
    base.id = draft.id;
  }
  return base;
}

function formatPermitDate(value?: string) {
  if (!value) return 'Date unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function scoreTone(score: number) {
  if (score >= 75) return { stroke: '#059669', text: 'text-emerald-700' };
  if (score >= 50) return { stroke: '#d97706', text: 'text-amber-700' };
  return { stroke: '#e11d48', text: 'text-rose-700' };
}

function HealthRingGauge({ score, headline }: { score: number; headline: string }) {
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const tone = scoreTone(clamped);

  return (
    <div className="flex flex-col items-center">
      <div className="relative h-[116px] w-[116px]">
        <svg viewBox="0 0 116 116" className="h-full w-full -rotate-90">
          <circle cx="58" cy="58" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="10" />
          <circle
            cx="58"
            cy="58"
            r={radius}
            fill="none"
            stroke={tone.stroke}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped / 100)}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-2xl font-bold tabular-nums ${tone.text}`}>{clamped}</span>
          <span className="text-[9px] font-bold uppercase tracking-widest text-slate-400">score</span>
        </div>
      </div>
      <div className="mt-1 text-[11px] font-bold text-slate-700">{headline}</div>
    </div>
  );
}

/** Share of useful life consumed, so remaining life is legible without reading numbers. */
function LifeBar({ ratio, muted }: { ratio: number | null; muted?: boolean }) {
  if (ratio == null) {
    return (
      <div className="h-1.5 w-full rounded-full bg-slate-200" title="Age unknown">
        <div className="h-full w-full rounded-full bg-[repeating-linear-gradient(45deg,#cbd5e1_0,#cbd5e1_4px,#e2e8f0_4px,#e2e8f0_8px)]" />
      </div>
    );
  }

  const pct = Math.min(100, ratio * 100);
  const color = ratio >= 1 ? 'bg-rose-500' : ratio >= 0.8 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className={`h-1.5 w-full rounded-full bg-slate-200 ${muted ? 'opacity-60' : ''}`}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(3, pct)}%` }} />
    </div>
  );
}

function EvidenceChip({ evidence, rationale }: { evidence: HealthEvidence; rationale?: string }) {
  const meta = HEALTH_EVIDENCE_META[evidence];
  const tone =
    evidence === 'inferred'
      ? 'border-slate-200 bg-slate-50 text-slate-500'
      : evidence === 'permit'
        ? 'border-cyan-200 bg-cyan-50 text-cyan-800'
        : evidence === 'service'
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-blue-200 bg-blue-50 text-blue-700';

  return (
    <span
      title={rationale || meta.label}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}
    >
      {meta.short}
    </span>
  );
}

/**
 * An inferred component the owner has not ruled on. Rendered distinctly from a
 * real record so a page full of educated guesses is never mistaken for a page
 * full of facts.
 */
function SuggestionCard({
  asset,
  saving,
  onConfirm,
  onCorrect,
  onDismiss,
}: {
  asset: PropertyHealthAsset;
  saving: boolean;
  onConfirm: () => void;
  onCorrect: () => void;
  onDismiss: () => void;
}) {
  const age = resolveAssetAgeYears(asset);
  const rationale = asset.provenance?.existence?.rationale
    ?? asset.provenance?.installedAt?.rationale;

  return (
    <article className="rounded-xl border border-blue-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
            {PROPERTY_HEALTH_CATEGORY_META[asset.category].label}
          </div>
          <h6 className="mt-0.5 truncate text-[13px] font-bold text-slate-900">
            {asset.name}
            {asset.material ? <span className="font-medium text-slate-500"> · {asset.material}</span> : null}
          </h6>
        </div>
        <EvidenceChip evidence={asset.evidence ?? 'inferred'} rationale={rationale} />
      </div>

      <div className="mt-1.5 flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-slate-500">Likely age</span>
        <span className="font-bold tabular-nums text-slate-800">{formatAgeLabel(age)}</span>
      </div>
      <div className="mt-1">
        <LifeBar ratio={resolveLifeUsedRatio(asset)} muted />
      </div>

      {rationale ? (
        <p className="mt-2 text-[11px] leading-snug text-slate-500">{rationale}</p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={saving}
          onClick={onConfirm}
          className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1 text-[11px] font-bold text-white transition hover:bg-slate-700 disabled:opacity-50"
        >
          <Check size={12} />
          Looks right
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onCorrect}
          className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          Correct it
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onDismiss}
          className="ml-auto rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-400 transition hover:text-slate-700 disabled:opacity-50"
        >
          Not here
        </button>
      </div>
    </article>
  );
}

function InventoryCard({
  asset,
  onEdit,
  onDelete,
}: {
  asset: PropertyHealthAsset;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const status = resolveAssetStatus(asset);
  const age = resolveAssetAgeYears(asset);
  const life = resolveUsefulLifeYears(asset);
  const statusMeta = STATUS_META[status];
  const remaining = age != null ? Math.max(0, life - age) : null;
  const ratio = resolveLifeUsedRatio(asset);

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-3 transition hover:border-slate-300">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
              {PROPERTY_HEALTH_CATEGORY_META[asset.category].label}
            </span>
            <EvidenceChip
              evidence={asset.evidence ?? 'owner'}
              rationale={asset.provenance?.installedAt?.rationale}
            />
          </div>
          <h6 className="mt-0.5 truncate text-[13px] font-bold text-slate-900" title={asset.name}>
            {asset.name}
          </h6>
          <p className="truncate text-[11px] text-slate-500">
            {[asset.make, asset.model].filter(Boolean).join(' ') || 'Make / model not set'}
            {asset.serialNumber ? ` · SN ${asset.serialNumber}` : ''}
          </p>
        </div>
        <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
      </div>

      <div className="mt-2.5">
        <LifeBar ratio={ratio} />
        <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] tabular-nums">
          <span className="text-slate-500">{formatAgeLabel(age)}</span>
          <span className="text-slate-400">
            of {life < 1 ? `${Math.round(life * 12)} mo` : `${life} yr`}
          </span>
          <span className="font-bold text-slate-800">
            {remaining == null
              ? '—'
              : remaining < 1
                ? `${Math.max(0, Math.round(remaining * 12))} mo left`
                : `${remaining.toFixed(1)} yr left`}
          </span>
        </div>
      </div>

      {asset.watchFor?.length ? (
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          <span className="font-semibold text-slate-600">Watch for:</span> {asset.watchFor.join(' · ')}
        </p>
      ) : null}

      {asset.installedAt ? (
        <p className="mt-1.5 text-[11px] text-slate-400">Installed {formatPermitDate(asset.installedAt)}</p>
      ) : null}
      {asset.notes ? <p className="mt-1 line-clamp-2 text-[11px] text-slate-500">{asset.notes}</p> : null}

      {(asset.attachments?.length || 0) > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {asset.attachments!.map((attachment) => (
            <a
              key={attachment.id}
              href={attachment.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[10px] font-medium text-slate-600 hover:bg-slate-50"
            >
              <FileText className="h-3 w-3" />
              {attachment.name}
            </a>
          ))}
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-bold text-slate-700 transition hover:bg-slate-50"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-slate-400 transition hover:text-rose-600"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
      </div>
    </article>
  );
}

export default function PropertyHealthTab({
  ownerId,
  propertyId,
  propertyAddress,
  yearBuilt,
  buildingPermits = [],
  state,
  county,
}: {
  ownerId?: string;
  propertyId?: string | null;
  propertyAddress?: string;
  yearBuilt?: number | null;
  buildingPermits?: BuildingPermit[];
  state?: string | null;
  county?: string | null;
}) {
  /*
   * The layered inventory comes from the shared hook so the twin's Health
   * overlay on Predictive Maintenance draws exactly what this tab lists.
   * `assets` here is the local, optimistic copy of the saved rows: a save
   * writes through and updates it without waiting for a refetch.
   */
  const {
    assets: hookAssets,
    savedAssets,
    loading: hookLoading,
    error: hookError,
  } = usePropertyHealthAssets({
    ownerId,
    propertyId,
    propertyAddress,
    yearBuilt,
    buildingPermits,
    state,
    county,
  });

  const [localSaved, setLocalSaved] = useState<PropertyHealthAsset[] | null>(null);
  const assets = localSaved ?? savedAssets;
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | PropertyHealthCategory>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<DraftAsset>(() => emptyDraft());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const researchedModelKeys = useRef(new Set<string>());
  const [modelProfiles, setModelProfiles] = useState<ComponentModelProfile[]>([]);

  // A property switch drops the optimistic copy so the next render shows the
  // incoming property's rows rather than the previous one's.
  useEffect(() => {
    setLocalSaved(null);
    setModelProfiles([]);
    researchedModelKeys.current.clear();
  }, [ownerId, propertyId]);

  const loading = hookLoading;

  const persist = async (nextAssets: PropertyHealthAsset[]) => {
    if (!ownerId || !propertyId) {
      throw new Error('Save this property first to track health history.');
    }
    setSaving(true);
    setError(null);
    try {
      await ownerPropertiesClient.saveHealthAssets(ownerId, propertyId, nextAssets);
      setLocalSaved(nextAssets);
      setMessage('Property health updated');
      window.setTimeout(() => setMessage(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save property health');
      throw err;
    } finally {
      setSaving(false);
    }
  };

  /*
   * What the owner sees is the saved inventory layered with everything we can
   * work out on their behalf: permits override vintage guesses, and both defer to
   * anything the owner or a technician has confirmed. Nothing here is persisted
   * until the owner confirms it, so a change to the priors reshapes the
   * suggestions instead of leaving stale rows in the database.
   *
   * The hook does that layering off the fetched rows; after a local save the
   * optimistic copy has to be re-layered here so the list updates immediately.
   */
  const displayAssets = useMemo(() => {
    if (!localSaved) return hookAssets;

    const permitAssets = buildAssetsFromPermits(buildingPermits);
    const { assets: priorAssets } = buildPropertyHealthPriors({
      yearBuilt,
      address: propertyAddress,
      state,
      county,
    });

    const withPriors = mergePriorsWithSaved(localSaved, priorAssets);
    // Tombstones exist only to stop the priors engine re-suggesting something the
    // owner said the property does not have. They are not part of the inventory.
    return mergePermitAssets(withPriors, permitAssets).filter((asset) => !asset.notApplicable);
  }, [hookAssets, localSaved, buildingPermits, yearBuilt, propertyAddress, state, county]);

  const suggestedAssets = useMemo(
    () => displayAssets.filter(isUnconfirmedAsset),
    [displayAssets],
  );
  const confirmedAssets = useMemo(
    () => displayAssets.filter((asset) => !isUnconfirmedAsset(asset)),
    [displayAssets],
  );

  /*
   * Fill the shared make/model registry in the background.
   *
   * Only confirmed units are researched. Searching an inferred "likely Rheem"
   * would turn one guess into a page of very specific-looking guesses. A failed
   * lookup is deliberately silent: the forecast keeps using category useful life
   * and can be sharpened when model research is available.
   */
  useEffect(() => {
    let cancelled = false;
    const candidates = confirmedAssets.filter((asset) => asset.make?.trim() && asset.model?.trim());
    const pending = candidates.filter((asset) => {
      const key = `${asset.category}:${asset.make!.trim().toLowerCase()}:${asset.model!.trim().toLowerCase()}`;
      if (researchedModelKeys.current.has(key)) return false;
      researchedModelKeys.current.add(key);
      return true;
    });
    if (pending.length === 0) return undefined;

    void Promise.all(pending.map(async (asset) => {
      try {
        const result = await ownerPropertiesClient.getComponentModelProfile({
          category: asset.category,
          make: asset.make!,
          model: asset.model!,
        });
        return result.ok ? result.profile : null;
      } catch {
        return null;
      }
    })).then((profiles) => {
      if (cancelled) return;
      setModelProfiles((current) => {
        const next = new Map(current.map((profile) => [profile.id, profile]));
        profiles.filter((profile): profile is ComponentModelProfile => Boolean(profile))
          .forEach((profile) => next.set(profile.id, profile));
        return [...next.values()];
      });
    });

    return () => {
      cancelled = true;
    };
  }, [confirmedAssets]);

  const score = useMemo(() => computePropertyHealthScore(displayAssets), [displayAssets]);

  const riskFlags = useMemo(
    () =>
      displayAssets
        .filter((asset) => asset.riskFlag)
        .sort((a, b) => (a.riskFlag!.severity === 'critical' ? -1 : 1)),
    [displayAssets],
  );

  const applyFilter = (list: PropertyHealthAsset[]) =>
    filter === 'all' ? list : list.filter((asset) => asset.category === filter);

  const sortByUrgency = (list: PropertyHealthAsset[]) =>
    [...list].sort((a, b) => {
      const rank = (status: PropertyHealthStatus) =>
        status === 'attention' ? 0 : status === 'monitor' ? 1 : status === 'unknown' ? 2 : 3;
      const statusDiff = rank(resolveAssetStatus(a)) - rank(resolveAssetStatus(b));
      if (statusDiff !== 0) return statusDiff;
      return a.name.localeCompare(b.name);
    });

  const filteredAssets = useMemo(
    () => sortByUrgency(applyFilter(confirmedAssets)),
    [confirmedAssets, filter],
  );
  const filteredSuggestions = useMemo(
    () => sortByUrgency(applyFilter(suggestedAssets)),
    [suggestedAssets, filter],
  );

  /** Accepts a suggestion as-is, promoting it from a guess to an owner-confirmed record. */
  const confirmSuggestion = async (suggestion: PropertyHealthAsset) => {
    const confirmed: PropertyHealthAsset = {
      ...suggestion,
      evidence: 'owner',
      source: suggestion.source === 'permit' ? 'permit' : 'manual',
      provenance: {
        ...suggestion.provenance,
        existence: {
          evidence: 'owner',
          confidence: 1,
          rationale: 'Confirmed by the owner.',
          observedAt: new Date().toISOString(),
        },
      },
      updatedAt: new Date().toISOString(),
    };
    try {
      await persist([...assets, confirmed]);
    } catch {
      // error already surfaced
    }
  };

  /** Records that the property does not have this component, so we stop asking. */
  const dismissSuggestion = async (suggestion: PropertyHealthAsset) => {
    try {
      await persist([
        ...assets,
        {
          ...suggestion,
          evidence: 'owner',
          source: 'manual',
          notApplicable: true,
          notes: 'Owner indicated this component does not apply to the property.',
          updatedAt: new Date().toISOString(),
        },
      ]);
    } catch {
      // error already surfaced
    }
  };

  const openCreate = (seed?: Partial<DraftAsset>) => {
    const category = seed?.category || 'hvac';
    setDraft(
      emptyDraft({
        ...seed,
        category,
        usefulLifeYears: String(PROPERTY_HEALTH_CATEGORY_META[category].defaultUsefulLifeYears),
      }),
    );
    setEditorOpen(true);
  };

  const openEdit = (asset: PropertyHealthAsset) => {
    setDraft(draftFromAsset(asset));
    setEditorOpen(true);
  };

  const handleSaveDraft = async () => {
    if (!draft.name.trim()) {
      setError('Give this component a name.');
      return;
    }
    const nextAsset = assetFromDraft(draft);
    const next = draft.id
      ? assets.map((asset) => (asset.id === draft.id ? { ...nextAsset, createdAt: asset.createdAt } : asset))
      : [...assets, nextAsset];
    try {
      await persist(next);
      setEditorOpen(false);
    } catch {
      // error already surfaced
    }
  };

  const handleDelete = async (assetId: string) => {
    if (!window.confirm('Remove this component from property health history?')) return;
    try {
      await persist(assets.filter((asset) => asset.id !== assetId));
    } catch {
      // error already surfaced
    }
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length || !ownerId || !propertyId) return;
    setUploading(true);
    setError(null);
    try {
      const uploaded: PropertyHealthAttachment[] = [];
      for (const file of Array.from(files)) {
        const result = await uploadPropertyDocument(ownerId, propertyId, file);
        if (!result.success || !result.downloadURL) {
          throw new Error(result.error || `Failed to upload ${file.name}`);
        }
        uploaded.push({
          id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          name: file.name,
          url: result.downloadURL,
          storagePath: result.storagePath,
          contentType: file.type,
          uploadedAt: new Date().toISOString(),
        });
      }
      setDraft((current) => ({
        ...current,
        attachments: [...current.attachments, ...uploaded],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const trackedCategories = useMemo(
    () => new Set(assets.map((asset) => asset.category)),
    [assets],
  );

  // Only components with recorded spend have anything to say about cost.
  const costSummaries = useMemo(
    () => summarizeComponentCosts(displayAssets).filter((summary) => summary.eventCount > 0),
    [displayAssets],
  );

  /*
   * Built from the saved inventory rather than `displayAssets`: an inferred
   * component is a guess about what is in the house, and the history is a record
   * of things that actually happened.
   */
  const historyEvents = useMemo(
    () => buildPropertyHistoryTimeline({ assets, permits: buildingPermits }),
    [assets, buildingPermits],
  );

  const maintenanceExposure = useMemo(
    () => inferPropertyMaintenanceExposure({
      address: propertyAddress,
      state,
      county,
    }),
    [propertyAddress, state, county],
  );

  const maintenanceForecast = useMemo(
    () => buildPropertyMaintenanceForecast(displayAssets, {
      exposure: maintenanceExposure,
      profiles: modelProfiles,
    }),
    [displayAssets, maintenanceExposure, modelProfiles],
  );

  if (!propertyId || !ownerId) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Property Health</div>
        <h4 className="mt-2 text-xl font-semibold text-slate-900">Save this property to start tracking</h4>
        <p className="mx-auto mt-2 max-w-lg text-sm text-slate-600">
          Once the property is on your account, you can log roof, HVAC, filters, smart home installs, and other component history here.
        </p>
      </div>
    );
  }

  const categoryOptions = [
    { id: 'all' as const, label: 'All' },
    ...(Object.keys(PROPERTY_HEALTH_CATEGORY_META) as PropertyHealthCategory[]).map((category) => ({
      id: category,
      label: PROPERTY_HEALTH_CATEGORY_META[category].label,
    })),
  ];

  return (
    <div className="space-y-5" data-voice-id="property-health-tab">
      {(error || message) && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            error
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {error || message}
        </div>
      )}

      <TwinCard
        tone="blue"
        icon={<ShieldCheck size={16} />}
        eyebrow="Property health"
        title={propertyAddress || 'Component inventory'}
        headerRight={
          <>
            <TwinPill tone={score.attention > 0 ? 'danger' : 'positive'}>
              {score.attention} needs attention
            </TwinPill>
            {score.monitor > 0 ? <TwinPill tone="warn">{score.monitor} to monitor</TwinPill> : null}
            {suggestedAssets.length > 0 ? (
              <TwinPill tone="info" icon={<Sparkles size={11} />}>
                {suggestedAssets.length} to confirm
              </TwinPill>
            ) : null}
            <TwinPill title={yearBuilt ? `Built ${yearBuilt}` : undefined}>
              {score.tracked} tracked
            </TwinPill>
          </>
        }
        toolbar={
          <>
            <TwinSegmented
              ariaLabel="Filter components by category"
              value={filter}
              onChange={(next) => setFilter(next)}
              options={categoryOptions}
            />
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => openCreate()}
              disabled={saving}
            >
              Add component
            </Button>
          </>
        }
        rail={
          <>
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <HealthRingGauge score={score.score} headline={score.headline} />
              <div className="mt-2 grid grid-cols-2 gap-2 text-center">
                <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                  <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Coverage</div>
                  <div className="text-sm font-bold tabular-nums text-slate-900">{score.coverage}%</div>
                </div>
                <div className="rounded-lg bg-slate-50 px-2 py-1.5">
                  <div className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Avg age</div>
                  <div className="text-sm font-bold tabular-nums text-slate-900">
                    {score.avgAgeYears != null ? formatAgeLabel(score.avgAgeYears).replace(' old', '') : '—'}
                  </div>
                </div>
              </div>
            </div>

            {score.deferredLiabilityUsd > 0 ? (
              <TwinRailSection title="Deferred liability" tone="warn">
                <div className="text-lg font-bold tabular-nums text-amber-900">
                  ${score.deferredLiabilityUsd.toLocaleString()}
                </div>
                <p className="mt-0.5 text-[11px] leading-snug text-amber-800">
                  Replacement cost of systems already past 85% of their expected life.
                </p>
              </TwinRailSection>
            ) : null}

            {riskFlags.map((asset) => (
              <TwinRailSection
                key={`flag-${asset.id}`}
                title={asset.riskFlag!.label}
                tone={asset.riskFlag!.severity === 'critical' ? 'danger' : 'warn'}
                action={<AlertTriangle size={13} className="text-amber-600" />}
              >
                <p className="text-[11px] leading-snug text-slate-700">{asset.riskFlag!.detail}</p>
              </TwinRailSection>
            ))}

            {score.missingCoreCategories.length > 0 ? (
              <TwinRailSection title="Not yet covered">
                <div className="flex flex-wrap gap-1">
                  {score.missingCoreCategories.map((category) => (
                    <button
                      key={category}
                      type="button"
                      onClick={() =>
                        openCreate({
                          category,
                          name: PROPERTY_HEALTH_CATEGORY_META[category].label,
                        })
                      }
                      className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-600 transition hover:border-slate-400 hover:text-slate-900"
                    >
                      + {PROPERTY_HEALTH_CATEGORY_META[category].label}
                    </button>
                  ))}
                </div>
              </TwinRailSection>
            ) : null}

            <TwinRailSection title="Quick add">
              <div className="flex flex-wrap gap-1">
                {PROPERTY_HEALTH_QUICK_ADD.map((item) => {
                  const alreadyTracked = trackedCategories.has(item.category)
                    && assets.some((asset) => asset.name.toLowerCase() === item.name.toLowerCase());
                  return (
                    <button
                      key={`${item.category}-${item.name}`}
                      type="button"
                      onClick={() => openCreate({ category: item.category, name: item.name })}
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-bold transition ${
                        alreadyTracked
                          ? 'border-slate-200 bg-slate-50 text-slate-400'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-400 hover:text-slate-900'
                      }`}
                    >
                      {item.name}
                    </button>
                  );
                })}
              </div>
            </TwinRailSection>
          </>
        }
      >
        {loading ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-10 text-center text-sm text-slate-500">
            Loading property health…
          </div>
        ) : (
          <div className="space-y-4">
            {filteredSuggestions.length > 0 ? (
              <div className="rounded-xl border border-dashed border-blue-300 bg-blue-50/40 p-3">
                <div className="flex items-center gap-1.5 text-blue-800">
                  <Sparkles size={13} />
                  <span className="text-[11px] font-bold uppercase tracking-[0.16em]">
                    What we think is here
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-slate-600">
                  Worked out from the property age, location, and permits on file. These are
                  starting points, not records — confirm or correct each one.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {filteredSuggestions.map((asset) => (
                    <SuggestionCard
                      key={asset.id}
                      asset={asset}
                      saving={saving}
                      onConfirm={() => void confirmSuggestion(asset)}
                      onCorrect={() => openEdit({ ...asset, evidence: 'owner' })}
                      onDismiss={() => void dismissSuggestion(asset)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {filteredAssets.length === 0 && filteredSuggestions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-10 text-center">
                <h5 className="text-base font-semibold text-slate-900">No components logged yet</h5>
                <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
                  {yearBuilt
                    ? 'Nothing matches this filter. Try another category.'
                    : 'Add a year built to this property and we can pre-fill a likely inventory for you.'}
                </p>
                <div className="mt-4">
                  <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => openCreate()}>
                    Add first component
                  </Button>
                </div>
              </div>
            ) : null}

            {filteredAssets.length > 0 ? (
              <div className="grid gap-2.5 xl:grid-cols-2">
                {filteredAssets.map((asset) => (
                  <InventoryCard
                    key={asset.id}
                    asset={asset}
                    onEdit={() => openEdit(asset)}
                    onDelete={() => void handleDelete(asset.id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )}
      </TwinCard>

      <PropertyMaintenanceForecast
        forecast={maintenanceForecast}
        propertyId={propertyId}
        propertyAddress={propertyAddress}
      />

      <HealthPhotoAnalysis
        ownerId={ownerId}
        propertyId={propertyId}
        propertyAddress={propertyAddress}
        assets={assets}
        saving={saving}
        onApply={persist}
      />

      <HealthDocumentIngest
        ownerId={ownerId}
        propertyId={propertyId}
        assets={assets}
        onApply={persist}
        saving={saving}
      />

      {costSummaries.length > 0 ? (
        <ComponentCostLedger summaries={costSummaries} />
      ) : null}

      <PropertyHistoryTimeline events={historyEvents} />

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        title={draft.id ? 'Edit component' : 'Add component'}
        size="lg"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Log install date, make/model, and supporting docs (receipts, photos of labels, invoices).
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Category" htmlFor="health-category">
              <SelectInput
                id="health-category"
                value={draft.category}
                onChange={(event) => {
                  const category = event.target.value as PropertyHealthCategory;
                  setDraft((current) => ({
                    ...current,
                    category,
                    usefulLifeYears: String(PROPERTY_HEALTH_CATEGORY_META[category].defaultUsefulLifeYears),
                    name: current.name || PROPERTY_HEALTH_CATEGORY_META[category].label,
                  }));
                }}
              >
                {(Object.keys(PROPERTY_HEALTH_CATEGORY_META) as PropertyHealthCategory[]).map((category) => (
                  <option key={category} value={category}>
                    {PROPERTY_HEALTH_CATEGORY_META[category].label}
                  </option>
                ))}
              </SelectInput>
            </Field>

            <Field label="Name" htmlFor="health-name" required>
              <input
                className={HEALTH_CONTROL_CLASS}
                id="health-name"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="e.g. Roof, Carrier HVAC, fridge water filter"
              />
            </Field>

            <Field label="Make" htmlFor="health-make">
              <input
                className={HEALTH_CONTROL_CLASS}
                id="health-make"
                value={draft.make}
                onChange={(event) => setDraft((current) => ({ ...current, make: event.target.value }))}
                placeholder="Manufacturer"
              />
            </Field>

            <Field label="Model" htmlFor="health-model">
              <input
                className={HEALTH_CONTROL_CLASS}
                id="health-model"
                value={draft.model}
                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
                placeholder="Model number"
              />
            </Field>

            <Field label="Serial number" htmlFor="health-serial">
              <input
                className={HEALTH_CONTROL_CLASS}
                id="health-serial"
                value={draft.serialNumber}
                onChange={(event) => setDraft((current) => ({ ...current, serialNumber: event.target.value }))}
                placeholder="Optional"
              />
            </Field>

            <Field label="Installed on" htmlFor="health-installed" hint="Preferred — used for exact age">
              <input
                className={HEALTH_CONTROL_CLASS}
                id="health-installed"
                type="date"
                value={draft.installedAt}
                onChange={(event) => setDraft((current) => ({ ...current, installedAt: event.target.value }))}
              />
            </Field>

            <Field
              label="Estimated age (years)"
              htmlFor="health-age"
              hint="Use when install date is unknown"
            >
              <input
                className={HEALTH_CONTROL_CLASS}
                id="health-age"
                type="number"
                min="0"
                step="0.1"
                value={draft.estimatedAgeYears}
                onChange={(event) => setDraft((current) => ({ ...current, estimatedAgeYears: event.target.value }))}
                placeholder="e.g. 12"
              />
            </Field>

            <Field label="Expected useful life (years)" htmlFor="health-life">
              <input
                className={HEALTH_CONTROL_CLASS}
                id="health-life"
                type="number"
                min="0.1"
                step="0.1"
                value={draft.usefulLifeYears}
                onChange={(event) => setDraft((current) => ({ ...current, usefulLifeYears: event.target.value }))}
              />
            </Field>
          </div>

          <Field label="Notes" htmlFor="health-notes">
            <textarea
              className={HEALTH_TEXTAREA_CLASS}
              id="health-notes"
              rows={3}
              value={draft.notes}
              onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              placeholder="Warranty details, installer, room location, filter size…"
            />
          </Field>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Uploads</div>
                <p className="text-xs text-slate-500">Receipts, photos of rating plates, invoices, install docs</p>
              </div>
              <Button
                size="sm"
                variant="secondary"
                icon={<Upload className="h-3.5 w-3.5" />}
                loading={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                Upload
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                multiple
                accept="image/*,.pdf,.doc,.docx,.txt"
                onChange={(event) => void handleUpload(event.target.files)}
              />
            </div>

            {draft.attachments.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {draft.attachments.map((attachment) => (
                  <li
                    key={attachment.id}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2"
                  >
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-2 text-sm font-medium text-slate-700 hover:text-slate-900"
                    >
                      <FileText className="h-4 w-4 shrink-0" />
                      <span className="truncate">{attachment.name}</span>
                    </a>
                    <button
                      type="button"
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          attachments: current.attachments.filter((item) => item.id !== attachment.id),
                        }))
                      }
                      aria-label={`Remove ${attachment.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-xs text-slate-500">No files attached yet.</p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="tertiary" onClick={() => setEditorOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={saving} onClick={() => void handleSaveDraft()}>
              {draft.id ? 'Save changes' : 'Add to property health'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
