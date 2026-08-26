import { describe, expect, it } from 'vitest';
import {
  acceptProposedDate,
  applyDocumentProposals,
  summarizeComponentCosts,
  type HealthDocumentProposal,
} from '../propertyHealthDocuments';
import {
  createEmptyHealthAsset,
  type HealthEvidence,
  type PropertyHealthAsset,
} from '../../types/propertyHealth';

const NOW = new Date('2026-07-01T00:00:00.000Z');

function proposal(over: Partial<HealthDocumentProposal> = {}): HealthDocumentProposal {
  return {
    id: 'p1',
    category: 'water_heater',
    workKind: 'replace',
    confidence: 0.8,
    documentId: 'doc1',
    documentName: 'Invoice 4471.pdf',
    documentKind: 'invoice',
    ...over,
  };
}

function asset(
  over: Partial<PropertyHealthAsset> & { evidence?: HealthEvidence } = {},
): PropertyHealthAsset {
  return createEmptyHealthAsset({
    category: 'water_heater',
    name: 'Water heater',
    ...over,
  });
}

describe('applyDocumentProposals — creating', () => {
  it('creates a component the inventory did not have', () => {
    const { assets, changes } = applyDocumentProposals(
      [],
      [proposal({ servicedAt: '2021-04-12', make: 'Rheem', amountUsd: 2400 })],
      NOW,
    );

    expect(assets).toHaveLength(1);
    expect(assets[0].category).toBe('water_heater');
    expect(assets[0].installedAt).toBe('2021-04-12');
    expect(assets[0].make).toBe('Rheem');
    expect(assets[0].evidence).toBe('document');
    expect(changes[0].outcome).toBe('created');
  });

  it('records the spend on a component it creates', () => {
    const { assets } = applyDocumentProposals(
      [],
      [proposal({ servicedAt: '2021-04-12', amountUsd: 2400 })],
      NOW,
    );

    expect(assets[0].spend).toHaveLength(1);
    expect(assets[0].spend![0].amountUsd).toBe(2400);
    expect(assets[0].spend![0].documentId).toBe('doc1');
  });

  it('creates without a date when the document only evidences a repair', () => {
    const { assets, changes } = applyDocumentProposals(
      [],
      [proposal({ workKind: 'repair', servicedAt: '2021-04-12', amountUsd: 180 })],
      NOW,
    );

    // The component exists, but a repair invoice says nothing about its age.
    expect(assets[0].installedAt).toBeNull();
    expect(assets[0].spend).toHaveLength(1);
    expect(changes[0].reason).toMatch(/age is still unknown/i);
  });
});

describe('applyDocumentProposals — the install date', () => {
  it('never re-dates a component from a repair', () => {
    const existing = asset({ installedAt: '2012-01-01', evidence: 'owner' });
    const { assets, changes } = applyDocumentProposals(
      [existing],
      [proposal({ workKind: 'repair', servicedAt: '2025-06-01', amountUsd: 240 })],
      NOW,
    );

    expect(assets[0].installedAt).toBe('2012-01-01');
    expect(changes[0].outcome).toBe('spend_only');
    expect(assets[0].spend).toHaveLength(1);
  });

  it('fills an install date that was missing', () => {
    const { assets, changes } = applyDocumentProposals(
      [asset({ installedAt: null, evidence: 'inferred' })],
      [proposal({ servicedAt: '2019-08-20' })],
      NOW,
    );

    expect(assets[0].installedAt).toBe('2019-08-20');
    expect(changes[0].fields).toContain('installedAt');
  });

  it('overwrites a weaker guess', () => {
    const { assets } = applyDocumentProposals(
      [asset({ installedAt: '2010-01-01', evidence: 'inferred' })],
      [proposal({ servicedAt: '2019-08-20' })],
      NOW,
    );

    expect(assets[0].installedAt).toBe('2019-08-20');
    expect(assets[0].evidence).toBe('document');
  });

  it('refuses to overrule the owner, and says what the conflict is', () => {
    const { assets, changes } = applyDocumentProposals(
      [asset({ installedAt: '2015-03-03', evidence: 'owner' })],
      [proposal({ servicedAt: '2019-08-20' })],
      NOW,
    );

    expect(assets[0].installedAt).toBe('2015-03-03');
    expect(changes[0].outcome).toBe('needs_review');
    expect(changes[0].conflict).toEqual({
      field: 'installedAt',
      current: '2015-03-03',
      proposed: '2019-08-20',
    });
  });

  it('refuses to overrule a technician', () => {
    const { assets, changes } = applyDocumentProposals(
      [asset({ installedAt: '2015-03-03', evidence: 'service' })],
      [proposal({ servicedAt: '2019-08-20' })],
      NOW,
    );

    expect(assets[0].installedAt).toBe('2015-03-03');
    expect(changes[0].outcome).toBe('needs_review');
    expect(assets[0].evidence).toBe('service');
  });

  it('raises confidence when the document agrees with the recorded date', () => {
    const existing = asset({ installedAt: '2019-08-20', evidence: 'inferred' });
    const { assets, changes } = applyDocumentProposals(
      [existing],
      [proposal({ servicedAt: '2019-08-20', confidence: 0.9 })],
      NOW,
    );

    expect(changes[0].outcome).not.toBe('needs_review');
    expect(assets[0].provenance?.installedAt?.evidence).toBe('document');
    expect(assets[0].provenance?.installedAt?.confidence).toBe(0.9);
  });

  it('ignores a date the extractor got wrong by putting it in the future', () => {
    const { assets, changes } = applyDocumentProposals(
      [asset({ installedAt: null, evidence: 'inferred' })],
      [proposal({ servicedAt: '2031-01-01' })],
      NOW,
    );

    expect(assets[0].installedAt).toBeNull();
    expect(changes[0].fields).not.toContain('installedAt');
  });

  it('ignores an unparseable date', () => {
    const { assets } = applyDocumentProposals(
      [asset({ installedAt: null })],
      [proposal({ servicedAt: 'sometime last spring' })],
      NOW,
    );
    expect(assets[0].installedAt).toBeNull();
  });
});

describe('applyDocumentProposals — filling blanks', () => {
  it('fills make and model without needing to outrank anything', () => {
    const { assets, changes } = applyDocumentProposals(
      [asset({ evidence: 'owner', installedAt: '2019-01-01' })],
      [proposal({ make: 'Rheem', model: 'XE50T10', servicedAt: '2019-01-01' })],
      NOW,
    );

    expect(assets[0].make).toBe('Rheem');
    expect(assets[0].model).toBe('XE50T10');
    expect(changes[0].outcome).toBe('enriched');
  });

  it('leaves a make the owner already entered alone', () => {
    const { assets } = applyDocumentProposals(
      [asset({ make: 'Bradford White', evidence: 'owner' })],
      [proposal({ make: 'Rheem', workKind: 'repair' })],
      NOW,
    );
    expect(assets[0].make).toBe('Bradford White');
  });
});

describe('applyDocumentProposals — duplicate uploads', () => {
  it('does not record the same document twice', () => {
    const first = applyDocumentProposals(
      [],
      [proposal({ servicedAt: '2021-04-12', amountUsd: 2400 })],
      NOW,
    );
    const second = applyDocumentProposals(
      first.assets,
      [proposal({ servicedAt: '2021-04-12', amountUsd: 2400 })],
      NOW,
    );

    expect(second.assets[0].spend).toHaveLength(1);
    expect(second.changes[0].outcome).toBe('skipped');
  });

  it('catches the same receipt arriving under a different document id', () => {
    const first = applyDocumentProposals(
      [],
      [proposal({ servicedAt: '2021-04-12', amountUsd: 2400 })],
      NOW,
    );
    const second = applyDocumentProposals(
      first.assets,
      [proposal({ documentId: 'doc2', servicedAt: '2021-04-12', amountUsd: 2400 })],
      NOW,
    );

    expect(second.assets[0].spend).toHaveLength(1);
    expect(second.changes[0].outcome).toBe('skipped');
  });

  it('still records a genuinely separate visit for the same amount', () => {
    const first = applyDocumentProposals(
      [],
      [proposal({ workKind: 'repair', servicedAt: '2024-04-12', amountUsd: 200 })],
      NOW,
    );
    const second = applyDocumentProposals(
      first.assets,
      [proposal({ id: 'p2', documentId: 'doc2', workKind: 'repair', servicedAt: '2025-11-02', amountUsd: 200 })],
      NOW,
    );

    expect(second.assets[0].spend).toHaveLength(2);
  });
});

describe('applyDocumentProposals — dismissed components', () => {
  it('does not attach to a component the owner said does not exist', () => {
    const { assets } = applyDocumentProposals(
      [asset({ notApplicable: true })],
      [proposal({ servicedAt: '2021-04-12' })],
      NOW,
    );

    // A new record is created rather than reviving the tombstone.
    expect(assets).toHaveLength(2);
    expect(assets[1].notApplicable).toBe(false);
  });
});

describe('acceptProposedDate', () => {
  it('records the owner as the source once they have chosen', () => {
    const existing = asset({ installedAt: '2015-03-03', evidence: 'owner' });
    const [updated] = acceptProposedDate([existing], existing.id, '2019-08-20', 'doc1', NOW);

    expect(updated.installedAt).toBe('2019-08-20');
    expect(updated.provenance?.installedAt?.evidence).toBe('owner');
    expect(updated.provenance?.installedAt?.confidence).toBe(1);
  });

  it('stops the same conflict being raised again', () => {
    const existing = asset({ installedAt: '2015-03-03', evidence: 'owner' });
    const [resolved] = acceptProposedDate([existing], existing.id, '2019-08-20', 'doc1', NOW);

    const { changes } = applyDocumentProposals(
      [resolved],
      [proposal({ documentId: 'doc9', servicedAt: '2019-08-20' })],
      NOW,
    );
    expect(changes[0].outcome).not.toBe('needs_review');
  });

  it('leaves other components untouched', () => {
    const a = asset({ installedAt: '2015-03-03' });
    const b = createEmptyHealthAsset({ category: 'hvac', name: 'Furnace', installedAt: '2010-01-01' });
    const out = acceptProposedDate([a, b], a.id, '2019-08-20', 'doc1', NOW);
    expect(out[1].installedAt).toBe('2010-01-01');
  });
});

describe('summarizeComponentCosts', () => {
  function withSpend(events: Array<{ amountUsd: number; workKind: 'repair' | 'replace'; occurredAt: string }>) {
    return asset({
      spend: events.map((event, i) => ({
        id: `s${i}`,
        occurredAt: event.occurredAt,
        amountUsd: event.amountUsd,
        workKind: event.workKind,
        createdAt: event.occurredAt,
      })),
    });
  }

  it('totals lifetime and repair spend separately', () => {
    const [summary] = summarizeComponentCosts(
      [withSpend([
        { amountUsd: 2400, workKind: 'replace', occurredAt: '2020-01-01' },
        { amountUsd: 300, workKind: 'repair', occurredAt: '2024-01-01' },
      ])],
      NOW,
    );

    expect(summary.lifetimeSpendUsd).toBe(2700);
    expect(summary.repairSpendUsd).toBe(300);
    expect(summary.capitalSpendUsd).toBe(2400);
    expect(summary.eventCount).toBe(2);
  });

  it('spreads a replacement over the life it buys, not the years since the receipt', () => {
    const roof = createEmptyHealthAsset({
      category: 'roof',
      name: 'Roof',
      usefulLifeYears: 25,
      spend: [
        { id: 'r', occurredAt: '2023-08-14', amountUsd: 18_400, workKind: 'replace', createdAt: '2023-08-14' },
      ],
    });

    const [summary] = summarizeComponentCosts([roof], NOW);

    // Naively dividing by the ~3 years since the receipt gave $6,230/yr.
    expect(Math.round(summary.annualizedUsd!)).toBe(736);
  });

  it('adds observed upkeep on top of the amortized replacement', () => {
    const heater = createEmptyHealthAsset({
      category: 'water_heater',
      name: 'Water heater',
      usefulLifeYears: 10,
      spend: [
        { id: 'a', occurredAt: '2016-07-01', amountUsd: 1200, workKind: 'replace', createdAt: '2016-07-01' },
        { id: 'b', occurredAt: '2024-07-01', amountUsd: 500, workKind: 'repair', createdAt: '2024-07-01' },
      ],
    });

    const [summary] = summarizeComponentCosts([heater], NOW);

    // $120/yr amortized replacement, plus $500 of repairs across 10 observed years.
    expect(Math.round(summary.annualizedUsd!)).toBe(170);
  });

  it('reports no annual cost for a component with no spend on record', () => {
    const [summary] = summarizeComponentCosts([asset()], NOW);
    expect(summary.annualizedUsd).toBeNull();
  });

  it('stays quiet about replacing when repairs are just maintenance', () => {
    const [summary] = summarizeComponentCosts(
      [withSpend([
        { amountUsd: 80, workKind: 'repair', occurredAt: '2023-01-01' },
        { amountUsd: 90, workKind: 'repair', occurredAt: '2024-01-01' },
      ])],
      NOW,
    );
    expect(summary.replaceSignal).toBeNull();
  });

  it('flags replacement once repairs approach the cost of a new unit', () => {
    // Water heater replacement is $2,200 in the category meta.
    const [summary] = summarizeComponentCosts(
      [withSpend([
        { amountUsd: 900, workKind: 'repair', occurredAt: '2024-01-01' },
        { amountUsd: 950, workKind: 'repair', occurredAt: '2025-06-01' },
      ])],
      NOW,
    );

    expect(summary.replaceSignal).not.toBeNull();
    expect(summary.replaceSignal!.repairShareOfReplacement).toBeGreaterThan(0.5);
  });

  it('does not flag on a single large repair', () => {
    const [summary] = summarizeComponentCosts(
      [withSpend([{ amountUsd: 1800, workKind: 'repair', occurredAt: '2025-06-01' }])],
      NOW,
    );
    // One expensive repair is bad luck; two is a pattern.
    expect(summary.replaceSignal).toBeNull();
  });

  it('ranks the most expensive component first', () => {
    const heater = withSpend([{ amountUsd: 2400, workKind: 'replace', occurredAt: '2020-01-01' }]);
    const furnace = createEmptyHealthAsset({
      category: 'hvac',
      name: 'Furnace',
      spend: [{ id: 'x', occurredAt: '2021-01-01', amountUsd: 8000, workKind: 'replace', createdAt: '2021-01-01' }],
    });

    const summaries = summarizeComponentCosts([heater, furnace], NOW);
    expect(summaries[0].category).toBe('hvac');
  });

  it('excludes components the owner dismissed', () => {
    const summaries = summarizeComponentCosts([asset({ notApplicable: true })], NOW);
    expect(summaries).toHaveLength(0);
  });
});
