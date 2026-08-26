import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  FileText,
  Loader2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import {
  HEALTH_WORK_KIND_META,
  PROPERTY_HEALTH_CATEGORY_META,
  type PropertyHealthAsset,
} from '../../types/propertyHealth';
import {
  acceptProposedDate,
  applyDocumentProposals,
  type HealthDocumentProposal,
  type ProposalChange,
  type ProposalOutcome,
} from '../../services/propertyHealthDocuments';
import { ownerPropertiesClient } from '../../services/ownerPropertiesClient';
import { uploadPropertyDocument } from '../../services/storageService';
import { Button } from '../../design-system/components/Button';

/**
 * Upload maintenance paperwork, then review what it changes before it lands.
 *
 * Deliberately a review step rather than a silent import. Extraction is good
 * enough to save the owner the typing and not good enough to be trusted with the
 * install date, which every remaining-life and forecast number is derived from —
 * a repair invoice read as a replacement would reset a component's age and
 * quietly make an ageing system look new.
 */

const OUTCOME_META: Record<
  ProposalOutcome,
  { label: string; className: string; dotClassName: string }
> = {
  created: {
    label: 'New component',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    dotClassName: 'bg-emerald-500',
  },
  enriched: {
    label: 'Fills in details',
    className: 'border-blue-200 bg-blue-50 text-blue-800',
    dotClassName: 'bg-blue-500',
  },
  spend_only: {
    label: 'Logs the cost',
    className: 'border-slate-200 bg-slate-50 text-slate-700',
    dotClassName: 'bg-slate-400',
  },
  needs_review: {
    label: 'Conflicts',
    className: 'border-amber-300 bg-amber-50 text-amber-900',
    dotClassName: 'bg-amber-500',
  },
  skipped: {
    label: 'Already recorded',
    className: 'border-slate-200 bg-slate-50 text-slate-500',
    dotClassName: 'bg-slate-300',
  },
};

/** A proposal plus which upload it came from, keyed uniquely across documents. */
interface QueuedProposal extends HealthDocumentProposal {
  key: string;
}

function money(amount?: number | null) {
  if (amount == null) return null;
  return `$${Math.round(amount).toLocaleString()}`;
}

export default function HealthDocumentIngest({
  ownerId,
  propertyId,
  assets,
  onApply,
  saving,
}: {
  ownerId: string;
  propertyId: string;
  /** The saved inventory. Proposals are previewed against this. */
  assets: PropertyHealthAsset[];
  onApply: (next: PropertyHealthAsset[]) => Promise<void>;
  saving: boolean;
}) {
  const [queue, setQueue] = useState<QueuedProposal[]>([]);
  const [reviewedFiles, setReviewedFiles] = useState<string[]>([]);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [useDocumentDate, setUseDocumentDate] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const active = useMemo(
    () => queue.filter((proposal) => !dismissed.has(proposal.key)),
    [queue, dismissed],
  );

  /*
   * The preview is the real merge run against the saved inventory, not a
   * separate description of it. Whatever the owner is shown here is exactly what
   * gets written, so the two cannot drift apart.
   */
  const preview = useMemo(
    () => applyDocumentProposals(assets, active),
    [assets, active],
  );

  const changeFor = (key: string): ProposalChange | undefined =>
    preview.changes.find((change) => change.proposalId === key);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);

    try {
      for (const file of Array.from(files)) {
        const uploaded = await uploadPropertyDocument(ownerId, propertyId, file);
        if (!uploaded.success || !uploaded.downloadURL) {
          throw new Error(uploaded.error || `Could not upload ${file.name}`);
        }

        const documentId = uploaded.storagePath || uploaded.downloadURL;
        const result = await ownerPropertiesClient.ingestHealthDocument({
          ownerId,
          propertyId,
          storagePath: uploaded.storagePath,
          fileUrl: uploaded.downloadURL,
          fileName: file.name,
          mimeType: file.type,
          documentId,
        });

        if (!result.ok || !result.proposals.length) {
          // The file is stored either way; it just told us nothing about a component.
          setUnreadable((current) => [...current, file.name]);
          continue;
        }

        setReviewedFiles((current) => [...current, file.name]);
        setQueue((current) => [
          ...current,
          ...result.proposals.map((proposal) => ({
            ...proposal,
            // Proposal ids are per-document, so they need namespacing to stay
            // unique once several uploads are queued together.
            key: `${proposal.documentId}:${proposal.id}`,
            id: `${proposal.documentId}:${proposal.id}`,
          })),
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that document');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleFile = async () => {
    setError(null);
    try {
      let next = preview.assets;

      // Conflicts the owner resolved in favour of the document are applied after
      // the merge, since the merge itself refuses to overrule stronger evidence.
      for (const change of preview.changes) {
        if (change.outcome !== 'needs_review') continue;
        if (!useDocumentDate.has(change.proposalId)) continue;
        const proposed = change.conflict?.proposed;
        if (!proposed) continue;
        next = acceptProposedDate(next, change.assetId, proposed, change.proposalId);
      }

      await onApply(next);
      setQueue([]);
      setDismissed(new Set());
      setUseDocumentDate(new Set());
      setReviewedFiles([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save these records');
    }
  };

  const discardAll = () => {
    setQueue([]);
    setDismissed(new Set());
    setUseDocumentDate(new Set());
    setReviewedFiles([]);
    setUnreadable([]);
  };

  const toggleDismissed = (key: string) => {
    setDismissed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const conflictCount = preview.changes.filter(
    (change) => change.outcome === 'needs_review' && !useDocumentDate.has(change.proposalId),
  ).length;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">
            Records &amp; receipts
          </div>
          <h5 className="mt-0.5 text-[15px] font-bold text-slate-950">
            Upload paperwork, we read it into the inventory
          </h5>
          <p className="mt-1 max-w-2xl text-[12px] leading-snug text-slate-600">
            Service invoices, install receipts, inspection reports, appliance manuals. We pull the
            component, the date, the make and model, and what it cost. Nothing is filed until you
            have looked at it.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(event) => void handleFiles(event.target.files)}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            onClick={() => inputRef.current?.click()}
            disabled={busy || saving}
          >
            {busy ? 'Reading…' : 'Upload records'}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          {error}
        </div>
      ) : null}

      {unreadable.length > 0 ? (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
          <span className="font-semibold">Stored, but nothing to file:</span>{' '}
          {unreadable.join(', ')}. We could not tell which component these relate to, so nothing was
          changed.
        </div>
      ) : null}

      {queue.length === 0 && !busy ? (
        <div
          className="mt-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/60 px-4 py-6 text-center"
          data-testid="health-ingest-empty"
        >
          <FileText className="mx-auto h-5 w-5 text-slate-400" />
          <p className="mx-auto mt-2 max-w-md text-[12px] leading-snug text-slate-600">
            Every record you add sharpens the forecast. A single install receipt replaces a guess at
            a component&apos;s age with the actual date, and its cost feeds the repair-versus-replace
            call later on.
          </p>
        </div>
      ) : null}

      {queue.length > 0 ? (
        <div className="mt-3 space-y-2" data-testid="health-ingest-review">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-blue-200 bg-blue-50/50 px-3 py-2">
            <div className="flex items-center gap-1.5 text-blue-900">
              <Sparkles size={13} />
              <span className="text-[11px] font-bold uppercase tracking-[0.16em]">
                {active.length} finding{active.length === 1 ? '' : 's'} from{' '}
                {reviewedFiles.length} document{reviewedFiles.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={discardAll}
                className="text-[11px] font-bold text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline"
                disabled={saving}
              >
                Discard
              </button>
              <Button
                size="sm"
                variant="primary"
                icon={<Check className="h-3.5 w-3.5" />}
                onClick={() => void handleFile()}
                disabled={saving || active.length === 0}
              >
                {saving ? 'Filing…' : `File ${active.length} record${active.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </div>

          {conflictCount > 0 ? (
            <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
              <p className="text-[12px] leading-snug text-amber-900">
                {conflictCount} document{conflictCount === 1 ? '' : 's'} disagree with a date you or
                a technician already recorded. Those dates stay as they are unless you say otherwise
                below.
              </p>
            </div>
          ) : null}

          <div className="grid gap-2 xl:grid-cols-2">
            {queue.map((proposal) => {
              const isDismissed = dismissed.has(proposal.key);
              const change = isDismissed ? undefined : changeFor(proposal.key);
              const outcome = change?.outcome ?? 'skipped';
              const meta = OUTCOME_META[outcome];
              const category = PROPERTY_HEALTH_CATEGORY_META[proposal.category];
              const work = HEALTH_WORK_KIND_META[proposal.workKind];
              const amount = money(proposal.amountUsd);

              return (
                <article
                  key={proposal.key}
                  className={`rounded-xl border p-3 transition ${
                    isDismissed
                      ? 'border-slate-200 bg-slate-50 opacity-60'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[13px] font-bold text-slate-950">
                          {proposal.name || category.label}
                        </span>
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">
                          {work.label}
                        </span>
                        {!isDismissed ? (
                          <span
                            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-bold ${meta.className}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClassName}`} />
                            {meta.label}
                          </span>
                        ) : null}
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-600">
                        {proposal.servicedAt ? <span>{proposal.servicedAt}</span> : null}
                        {proposal.vendor ? <span>· {proposal.vendor}</span> : null}
                        {amount ? <span className="font-semibold tabular-nums">· {amount}</span> : null}
                        {proposal.make || proposal.model ? (
                          <span>· {[proposal.make, proposal.model].filter(Boolean).join(' ')}</span>
                        ) : null}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => toggleDismissed(proposal.key)}
                      title={isDismissed ? 'Include this finding' : 'Ignore this finding'}
                      className="shrink-0 rounded-lg border border-slate-200 p-1 text-slate-400 transition hover:border-slate-400 hover:text-slate-700"
                    >
                      {isDismissed ? <Check size={12} /> : <X size={12} />}
                    </button>
                  </div>

                  {change ? (
                    <p className="mt-2 text-[11px] leading-snug text-slate-600">{change.reason}</p>
                  ) : null}

                  {change?.conflict ? (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50/70 p-2">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-amber-900">
                        <span>On record: {change.conflict.current}</span>
                        <span className="text-amber-500">vs</span>
                        <span>Document: {change.conflict.proposed}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setUseDocumentDate((current) => {
                              const next = new Set(current);
                              next.delete(proposal.key);
                              return next;
                            })
                          }
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-bold transition ${
                            useDocumentDate.has(proposal.key)
                              ? 'border-slate-200 bg-white text-slate-500'
                              : 'border-slate-900 bg-slate-900 text-white'
                          }`}
                        >
                          Keep {change.conflict.current}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setUseDocumentDate((current) => new Set(current).add(proposal.key))
                          }
                          className={`rounded-full border px-2 py-0.5 text-[10px] font-bold transition ${
                            useDocumentDate.has(proposal.key)
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-200 bg-white text-slate-500'
                          }`}
                        >
                          Use {change.conflict.proposed}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-100 pt-1.5">
                    <span className="truncate text-[10px] text-slate-400" title={proposal.documentName}>
                      {proposal.documentName || 'Uploaded document'}
                    </span>
                    <span className="shrink-0 text-[10px] font-bold tabular-nums text-slate-400">
                      {Math.round(proposal.confidence * 100)}% confident
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
