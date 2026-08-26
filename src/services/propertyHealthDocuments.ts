import {
  HEALTH_WORK_KIND_META,
  PROPERTY_HEALTH_CATEGORY_META,
  createEmptyHealthAsset,
  isHigherEvidence,
  resolveUsefulLifeYears,
  type HealthSpendEvent,
  type HealthWorkKind,
  type PropertyHealthAsset,
  type PropertyHealthCategory,
} from '../types/propertyHealth';

/**
 * Turning uploaded receipts and service records into inventory changes.
 *
 * The extraction itself happens server-side against the existing Azure and
 * Claude document pipeline. What lives here is the part that has to be right
 * and has to be testable: deciding what a document is allowed to change.
 *
 * Nothing in here writes. It produces a reviewed set of changes, because
 * extraction is probabilistic in a way the inventory is not: a document naming
 * a water heater may be a valve repair rather than a replacement, and dating
 * the component from it would quietly corrupt the one number every age,
 * remaining-life and forecast calculation is built on. So a document can raise
 * confidence, add spend, and fill blanks on its own, but it can only overwrite
 * a fact the owner already stated by being shown to them first.
 */

export type HealthDocumentKind =
  | 'receipt'
  | 'invoice'
  | 'estimate'
  | 'inspection'
  | 'manual'
  | 'permit'
  | 'other';

/** One component's worth of findings from a single document. */
export interface HealthDocumentProposal {
  id: string;
  category: PropertyHealthCategory;
  /** What the document calls the component, if it names it. */
  name?: string;
  make?: string;
  model?: string;
  serialNumber?: string;
  /** When the work happened. ISO date. */
  servicedAt?: string | null;
  workKind: HealthWorkKind;
  vendor?: string;
  amountUsd?: number | null;
  description?: string;
  /** 0-1, from the extractor. Carried into field provenance. */
  confidence: number;
  documentId: string;
  documentName?: string;
  documentKind: HealthDocumentKind;
  /** Plain-language reason, shown to the owner in the review list. */
  rationale?: string;
}

/** What the server made of an uploaded document, before anything is applied. */
export interface HealthDocumentIngestResult {
  ok: boolean;
  status?: 'completed' | 'partial' | 'failed' | 'skipped';
  error?: string | null;
  reason?: string;
  document?: {
    id?: string;
    name?: string;
    mimeType?: string;
    documentType?: string;
    documentKind?: HealthDocumentKind;
    summary?: string;
    vendor?: string;
    documentDate?: string | null;
    totalUsd?: number | null;
    pageCount?: number;
    extractionQuality?: 'high' | 'medium' | 'low';
  };
  proposals: HealthDocumentProposal[];
}

export type ProposalOutcome =
  /** No record for this category existed, so one was created. */
  | 'created'
  /** An existing record gained facts it did not have. */
  | 'enriched'
  /** Only money was recorded; the component's identity was left alone. */
  | 'spend_only'
  /** The document contradicts something better-evidenced. Needs the owner. */
  | 'needs_review'
  /** Nothing usable, or already recorded. */
  | 'skipped';

export interface ProposalChange {
  proposalId: string;
  assetId: string;
  assetName: string;
  category: PropertyHealthCategory;
  outcome: ProposalOutcome;
  /** Asset fields this proposal set or would set. */
  fields: string[];
  /** Why it landed this way, in words the owner can read. */
  reason: string;
  /** Present when the outcome needs the owner to choose. */
  conflict?: {
    field: string;
    current: string;
    proposed: string;
  };
}

export interface ProposalApplication {
  assets: PropertyHealthAsset[];
  changes: ProposalChange[];
}

/* ── helpers ───────────────────────────────────────────────────────── */

function isUsableDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return false;
  // A receipt dated in the future is an extraction error, not a fact.
  return time <= Date.now() + 86_400_000;
}

function sameDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10);
}

/**
 * Whether this document has already been recorded against the component.
 *
 * Owners re-upload the same receipt, and the same invoice arrives once from a
 * scan and once from an emailed PDF. Without this, lifetime spend inflates
 * every time and the timeline grows duplicate entries.
 */
function alreadyRecorded(asset: PropertyHealthAsset, proposal: HealthDocumentProposal): boolean {
  const spend = asset.spend ?? [];
  return spend.some((event) => {
    if (proposal.documentId && event.documentId === proposal.documentId) return true;
    // Same day, same money, same kind: the same event arriving by another route.
    return (
      proposal.amountUsd != null
      && event.amountUsd === proposal.amountUsd
      && isUsableDate(proposal.servicedAt)
      && sameDay(event.occurredAt, proposal.servicedAt)
      && event.workKind === proposal.workKind
    );
  });
}

function spendFrom(proposal: HealthDocumentProposal, now: string): HealthSpendEvent | null {
  if (proposal.amountUsd == null || !(proposal.amountUsd > 0)) return null;
  return {
    id: `spend_${proposal.documentId}_${proposal.id}`,
    occurredAt: isUsableDate(proposal.servicedAt) ? proposal.servicedAt : now,
    amountUsd: proposal.amountUsd,
    workKind: proposal.workKind,
    vendor: proposal.vendor,
    description: proposal.description,
    documentId: proposal.documentId,
    createdAt: now,
  };
}

function provenanceFor(proposal: HealthDocumentProposal, now: string) {
  return {
    evidence: 'document' as const,
    confidence: Math.max(0, Math.min(1, proposal.confidence)),
    rationale: proposal.rationale
      ?? `${HEALTH_WORK_KIND_META[proposal.workKind].label} per ${proposal.documentName ?? 'uploaded document'}`,
    sourceRef: proposal.documentId,
    observedAt: now,
  };
}

/* ── applying ──────────────────────────────────────────────────────── */

/**
 * Folds document findings into the inventory, reporting what each one did.
 *
 * Deliberately returns the changes alongside the assets: the caller shows them
 * for review rather than persisting silently, and a change marked
 * `needs_review` carries the conflict so the owner can be asked the actual
 * question instead of being told the record was updated.
 */
export function applyDocumentProposals(
  assets: PropertyHealthAsset[],
  proposals: HealthDocumentProposal[],
  now = new Date(),
): ProposalApplication {
  const nowIso = now.toISOString();
  const next = assets.map((asset) => ({ ...asset }));
  const changes: ProposalChange[] = [];

  for (const proposal of proposals) {
    const meta = PROPERTY_HEALTH_CATEGORY_META[proposal.category];
    const datesComponent = HEALTH_WORK_KIND_META[proposal.workKind].datesComponent;
    const spend = spendFrom(proposal, nowIso);

    let index = next.findIndex(
      (asset) => asset.category === proposal.category && !asset.notApplicable,
    );

    /* ── nothing tracked here yet ── */
    if (index < 0) {
      const created = createEmptyHealthAsset({
        category: proposal.category,
        name: proposal.name || meta.label,
        make: proposal.make,
        model: proposal.model,
        serialNumber: proposal.serialNumber,
        installedAt: datesComponent && isUsableDate(proposal.servicedAt)
          ? proposal.servicedAt
          : null,
        source: 'import',
        evidence: 'document',
        spend: spend ? [spend] : [],
        provenance: {
          existence: provenanceFor(proposal, nowIso),
          ...(datesComponent && isUsableDate(proposal.servicedAt)
            ? { installedAt: provenanceFor(proposal, nowIso) }
            : {}),
        },
      });

      next.push(created);
      changes.push({
        proposalId: proposal.id,
        assetId: created.id,
        assetName: created.name,
        category: proposal.category,
        outcome: 'created',
        fields: [
          'existence',
          ...(created.installedAt ? ['installedAt'] : []),
          ...(proposal.make ? ['make'] : []),
          ...(proposal.model ? ['model'] : []),
          ...(spend ? ['spend'] : []),
        ],
        reason: datesComponent
          ? `Not tracked before. ${meta.label} added and dated from this document.`
          : `Not tracked before. ${meta.label} added, but the work was a `
            + `${HEALTH_WORK_KIND_META[proposal.workKind].label.toLowerCase()} so its age is still unknown.`,
      });
      continue;
    }

    const current = next[index];

    if (alreadyRecorded(current, proposal)) {
      changes.push({
        proposalId: proposal.id,
        assetId: current.id,
        assetName: current.name,
        category: proposal.category,
        outcome: 'skipped',
        fields: [],
        reason: 'This document is already recorded against the component.',
      });
      continue;
    }

    const fields: string[] = [];
    const updated: PropertyHealthAsset = { ...current };
    const provenance = { ...(current.provenance ?? {}) };

    // Blanks get filled regardless of evidence rank: there is nothing to contradict.
    if (!updated.make && proposal.make) {
      updated.make = proposal.make;
      provenance.make = provenanceFor(proposal, nowIso);
      fields.push('make');
    }
    if (!updated.model && proposal.model) {
      updated.model = proposal.model;
      provenance.model = provenanceFor(proposal, nowIso);
      fields.push('model');
    }
    if (!updated.serialNumber && proposal.serialNumber) {
      updated.serialNumber = proposal.serialNumber;
      fields.push('serialNumber');
    }

    if (spend) {
      updated.spend = [...(current.spend ?? []), spend];
      fields.push('spend');
    }

    /* ── the install date, which is the fact worth being careful about ── */
    let conflict: ProposalChange['conflict'] | undefined;
    let dateOutcome: ProposalOutcome | null = null;

    if (datesComponent && isUsableDate(proposal.servicedAt)) {
      const heldEvidence = provenance.installedAt?.evidence
        ?? current.evidence
        ?? 'owner';

      if (!current.installedAt) {
        updated.installedAt = proposal.servicedAt;
        provenance.installedAt = provenanceFor(proposal, nowIso);
        fields.push('installedAt');
      } else if (sameDay(current.installedAt, proposal.servicedAt)) {
        // Agreement is still worth something: it raises confidence in the date.
        provenance.installedAt = provenanceFor(proposal, nowIso);
        fields.push('installedAt');
      } else if (isHigherEvidence('document', heldEvidence)) {
        updated.installedAt = proposal.servicedAt;
        provenance.installedAt = provenanceFor(proposal, nowIso);
        fields.push('installedAt');
      } else {
        // A document cannot silently overrule the owner or a technician.
        dateOutcome = 'needs_review';
        conflict = {
          field: 'installedAt',
          current: current.installedAt.slice(0, 10),
          proposed: proposal.servicedAt.slice(0, 10),
        };
      }
    }

    // Existence evidence only ever climbs.
    if (isHigherEvidence('document', current.evidence ?? 'owner')) {
      updated.evidence = 'document';
      provenance.existence = provenanceFor(proposal, nowIso);
      fields.push('evidence');
    }

    updated.provenance = provenance;
    updated.updatedAt = nowIso;
    next[index] = updated;

    const outcome: ProposalOutcome = dateOutcome
      ?? (fields.some((field) => field !== 'spend')
        ? 'enriched'
        : fields.length
          ? 'spend_only'
          : 'skipped');

    changes.push({
      proposalId: proposal.id,
      assetId: updated.id,
      assetName: updated.name,
      category: proposal.category,
      outcome,
      fields,
      conflict,
      reason: reasonFor(outcome, proposal, conflict),
    });
  }

  return { assets: next, changes };
}

function reasonFor(
  outcome: ProposalOutcome,
  proposal: HealthDocumentProposal,
  conflict?: ProposalChange['conflict'],
): string {
  const work = HEALTH_WORK_KIND_META[proposal.workKind].label.toLowerCase();

  switch (outcome) {
    case 'needs_review':
      return `This document dates the component to ${conflict?.proposed}, but `
        + `${conflict?.current} is already recorded from a stronger source. `
        + 'Pick which one is right.';
    case 'spend_only':
      return `Recorded as a ${work} against the existing component. A ${work} does not `
        + 'change its age, so the install date was left alone.';
    case 'enriched':
      return `Filled in details the record was missing, from this ${proposal.documentKind}.`;
    default:
      return 'Nothing new in this document for that component.';
  }
}

/**
 * Accepts a conflicting date after the owner picked the document's version.
 *
 * Recorded as `owner` rather than `document`: the owner has now looked at both
 * and chosen, which is a stronger claim than the receipt was on its own, and it
 * stops the same conflict being raised on every later upload.
 */
export function acceptProposedDate(
  assets: PropertyHealthAsset[],
  assetId: string,
  installedAt: string,
  sourceRef?: string,
  now = new Date(),
): PropertyHealthAsset[] {
  const nowIso = now.toISOString();

  return assets.map((asset) => {
    if (asset.id !== assetId) return asset;
    return {
      ...asset,
      installedAt,
      evidence: 'owner',
      updatedAt: nowIso,
      provenance: {
        ...(asset.provenance ?? {}),
        installedAt: {
          evidence: 'owner',
          confidence: 1,
          rationale: 'Owner confirmed the date from an uploaded document',
          sourceRef,
          observedAt: nowIso,
        },
      },
    };
  });
}

/* ── cost rollups ──────────────────────────────────────────────────── */

export interface ComponentCostSummary {
  assetId: string;
  category: PropertyHealthCategory;
  name: string;
  lifetimeSpendUsd: number;
  repairSpendUsd: number;
  /** Install and replacement spend, as opposed to keeping it running. */
  capitalSpendUsd: number;
  eventCount: number;
  /**
   * True annual cost of owning this component: replacement spread over the life
   * it buys, plus the observed rate of keeping it running.
   *
   * Not total spend over the years we have records for. That reading made a roof
   * replaced three years ago look like a $6,000-a-year expense, when spread over
   * the twenty-five years it will last it is nearer $700.
   */
  annualizedUsd: number | null;
  replacementUsd: number;
  /**
   * Set when repairs have added up far enough that replacing is the better
   * trade. Deliberately conservative: two repairs is a coincidence.
   */
  replaceSignal: {
    reason: string;
    repairShareOfReplacement: number;
  } | null;
}

/**
 * What each component has actually cost, and when to stop repairing it.
 *
 * The signal fires on repair spend against replacement cost rather than on
 * repair count, because three $80 service calls are maintenance while two $900
 * repairs on a $2,200 unit are most of a new one.
 */
export function summarizeComponentCosts(
  assets: PropertyHealthAsset[],
  now = new Date(),
): ComponentCostSummary[] {
  return assets
    .filter((asset) => !asset.notApplicable)
    .map((asset) => {
      const events = asset.spend ?? [];
      const lifetimeSpendUsd = events.reduce((sum, event) => sum + event.amountUsd, 0);
      const repairSpendUsd = events
        .filter((event) => !HEALTH_WORK_KIND_META[event.workKind].datesComponent)
        .reduce((sum, event) => sum + event.amountUsd, 0);
      const capitalSpendUsd = lifetimeSpendUsd - repairSpendUsd;

      const replacementUsd = PROPERTY_HEALTH_CATEGORY_META[asset.category].typicalReplacementUsd;

      const firstEvent = events
        .map((event) => Date.parse(event.occurredAt))
        .filter((time) => !Number.isNaN(time))
        .sort((a, b) => a - b)[0];
      const spanYears = firstEvent
        ? Math.max(1, (now.getTime() - firstEvent) / (365.25 * 24 * 3600 * 1000))
        : null;

      // Capital is amortized over the life it buys; upkeep over the period we
      // have actually observed.
      const life = resolveUsefulLifeYears(asset);
      const amortizedCapital = life > 0 ? capitalSpendUsd / life : 0;
      const observedUpkeep = spanYears ? repairSpendUsd / spanYears : 0;
      const annualizedUsd = events.length ? amortizedCapital + observedUpkeep : null;

      const repairShareOfReplacement = replacementUsd > 0 ? repairSpendUsd / replacementUsd : 0;
      const repairCount = events.filter(
        (event) => event.workKind === 'repair',
      ).length;

      const replaceSignal = repairShareOfReplacement >= 0.5 && repairCount >= 2
        ? {
            reason: `Repairs have reached $${Math.round(repairSpendUsd).toLocaleString()} against a `
              + `$${replacementUsd.toLocaleString()} replacement. Another failure puts you past the `
              + 'cost of a new one.',
            repairShareOfReplacement,
          }
        : null;

      return {
        assetId: asset.id,
        category: asset.category,
        name: asset.name,
        lifetimeSpendUsd,
        repairSpendUsd,
        capitalSpendUsd,
        eventCount: events.length,
        annualizedUsd,
        replacementUsd,
        replaceSignal,
      };
    })
    .sort((a, b) => b.lifetimeSpendUsd - a.lifetimeSpendUsd);
}
