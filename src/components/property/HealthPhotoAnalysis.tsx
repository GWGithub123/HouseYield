import { useMemo, useRef, useState } from 'react';
import { Camera, Check, Loader2, Search, Upload, X } from 'lucide-react';

import type {
  PropertyHealthAsset,
  PropertyHealthAttachment,
} from '../../types/propertyHealth';
import {
  applyHealthPhotoAnalysis,
  type HealthPhotoAnalysis,
} from '../../services/propertyHealthPhotos';
import { ownerPropertiesClient } from '../../services/ownerPropertiesClient';
import { buildOwnerFinanceUrl } from '../../services/ownerFinanceApi';
import { uploadPropertyDocument } from '../../services/storageService';
import { Button } from '../../design-system/components/Button';
import { TwinCard, TwinPill } from './TwinCard';

export default function HealthPhotoAnalysis({
  ownerId,
  propertyId,
  propertyAddress,
  assets,
  saving,
  onApply,
}: {
  ownerId: string;
  propertyId: string;
  propertyAddress?: string;
  assets: PropertyHealthAsset[];
  saving: boolean;
  onApply: (assets: PropertyHealthAsset[]) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const eligible = useMemo(
    () => assets.filter((asset) => !asset.notApplicable && (asset.evidence ?? 'owner') !== 'inferred'),
    [assets],
  );
  const [assetId, setAssetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<HealthPhotoAnalysis | null>(null);
  const [attachment, setAttachment] = useState<PropertyHealthAttachment | null>(null);
  const selected = eligible.find((asset) => asset.id === assetId)
    ?? eligible[0]
    ?? null;

  const analyze = async (file: File, sourceKind: 'owner_photo' | 'aerial' = 'owner_photo') => {
    if (!selected) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose a photo rather than a PDF or document.');
      return;
    }
    setBusy(true);
    setError(null);
    setAnalysis(null);
    setAttachment(null);
    try {
      const uploaded = await uploadPropertyDocument(ownerId, propertyId, file);
      if (!uploaded.success || !uploaded.downloadURL) {
        throw new Error(uploaded.error || 'Photo upload failed');
      }
      const nextAttachment: PropertyHealthAttachment = {
        id: `photo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name: file.name,
        url: uploaded.downloadURL,
        storagePath: uploaded.storagePath,
        contentType: file.type,
        uploadedAt: new Date().toISOString(),
      };
      const result = await ownerPropertiesClient.analyzeHealthPhoto({
        ownerId,
        propertyId,
        storagePath: uploaded.storagePath,
        fileUrl: uploaded.downloadURL,
        category: selected.category,
        name: selected.name,
        make: selected.make,
        model: selected.model,
        sourceKind,
      });
      if (!result.ok || !result.analysis) {
        throw new Error(result.error || 'The photo could not be analyzed');
      }
      setAttachment(nextAttachment);
      setAnalysis(result.analysis);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Photo analysis failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const analyzeAerialRoof = async () => {
    if (!selected || selected.category !== 'roof' || !propertyAddress) return;
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        address: propertyAddress,
        type: 'satellite',
        width: '640',
        height: '640',
      });
      const response = await fetch(buildOwnerFinanceUrl(`/api/streetview/capture?${query}`));
      const payload = await response.json();
      if (!response.ok || !payload?.base64) {
        throw new Error(payload?.error || 'Satellite capture failed');
      }
      const dataResponse = await fetch(payload.base64);
      const blob = await dataResponse.blob();
      const file = new File(
        [blob],
        `aerial-roof-${new Date().toISOString().slice(0, 10)}.jpg`,
        { type: payload.contentType || 'image/jpeg' },
      );
      await analyze(file, 'aerial');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Satellite roof analysis failed');
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!selected || !analysis || !attachment) return;
    const next = assets.map((asset) =>
      asset.id === selected.id
        ? applyHealthPhotoAnalysis(asset, analysis, attachment)
        : asset
    );
    await onApply(next);
    setAnalysis(null);
    setAttachment(null);
  };

  return (
    <TwinCard
      tone="slate"
      icon={<Camera size={16} />}
      eyebrow="Visual inspection"
      title="Analyze a component photo"
      headerRight={
        analysis ? (
          <TwinPill tone={analysis.urgency === 'urgent' ? 'danger' : analysis.urgency === 'soon' ? 'warn' : 'info'}>
            {analysis.conditionScore == null ? 'Condition unknown' : `${Math.round(analysis.conditionScore)}/100 visible condition`}
          </TwinPill>
        ) : null
      }
      rail={
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">
            What a photo can prove
          </div>
          <ul className="mt-1.5 space-y-1 text-[10.5px] leading-snug text-slate-600">
            <li>• Visible wear, corrosion, staining, and damage</li>
            <li>• Make, model, and serial from a legible plate</li>
            <li>• A dated visual-condition record</li>
          </ul>
          <p className="mt-2 text-[10px] leading-snug text-slate-400">
            It cannot prove hidden damage or installation date. Those remain owner or technician decisions.
          </p>
        </div>
      }
    >
      {eligible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-7 text-center text-sm text-slate-500">
          Confirm a component first, then attach a photo to it.
        </div>
      ) : (
        <div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                Component
              </span>
              <select
                value={selected?.id || ''}
                onChange={(event) => {
                  setAssetId(event.target.value);
                  setAnalysis(null);
                  setAttachment(null);
                  setError(null);
                }}
                className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800"
              >
                {eligible.map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.name}</option>
                ))}
              </select>
            </label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void analyze(file);
              }}
            />
            <Button
              size="sm"
              variant="primary"
              icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              disabled={busy || saving}
              onClick={() => fileRef.current?.click()}
            >
              {busy ? 'Reading photo…' : 'Upload photo'}
            </Button>
            {selected?.category === 'roof' && propertyAddress ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Search className="h-3.5 w-3.5" />}
                disabled={busy || saving}
                onClick={() => void analyzeAerialRoof()}
              >
                Analyze aerial roof
              </Button>
            ) : null}
          </div>

          {error ? (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
              {error}
            </div>
          ) : null}

          {analysis && attachment ? (
            <div className="mt-3 grid gap-3 md:grid-cols-[160px_minmax(0,1fr)]">
              <img
                src={attachment.url}
                alt={`Inspection of ${selected?.name || 'component'}`}
                className="h-36 w-full rounded-xl border border-slate-200 object-cover"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-bold text-slate-900">
                    {analysis.summary || 'Photo analysis complete'}
                  </span>
                  <TwinPill tone="info">{Math.round(analysis.confidence * 100)}% confidence</TwinPill>
                </div>
                {(analysis.make || analysis.model || analysis.serialNumber) ? (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-600">
                    {analysis.make || analysis.model ? (
                      <span><b>Identity:</b> {[analysis.make, analysis.model].filter(Boolean).join(' ')}</span>
                    ) : null}
                    {analysis.serialNumber ? <span><b>Serial:</b> {analysis.serialNumber}</span> : null}
                    {analysis.manufactureDate ? (
                      <span title="Manufacture date is not used as installation date">
                        <b>Manufactured:</b> {analysis.manufactureDate}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {analysis.observations.length > 0 ? (
                  <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                    {analysis.observations.slice(0, 6).map((observation, index) => (
                      <li key={`${observation.label}-${index}`} className="rounded-lg bg-slate-50 px-2 py-1.5 text-[10.5px]">
                        <div className="font-bold text-slate-700">{observation.label}</div>
                        <div className="text-slate-500">{observation.evidence}</div>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Check className="h-3.5 w-3.5" />}
                    disabled={saving}
                    onClick={() => void apply()}
                  >
                    Accept photo evidence
                  </Button>
                  {analysis.modelIdentityReady ? (
                    <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-cyan-700">
                      <Search size={12} />
                      Model reliability research will run after save
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setAnalysis(null);
                      setAttachment(null);
                    }}
                    className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-semibold text-slate-400 hover:text-slate-700"
                  >
                    <X size={12} /> Dismiss
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </TwinCard>
  );
}
