import { describe, expect, it } from 'vitest';
import { __testing } from '../propertyHealthDocumentIngest.js';

const { normalizeFindings, pickDate, pickMoney } = __testing;

const DOC = { documentId: 'doc1', documentName: 'Invoice.pdf' };

/*
 * These guard the boundary where model output becomes inventory data. Anything
 * the distiller returns is untrusted: a hallucinated category, a date in the
 * future or a misread decimal all have to be dropped here rather than reaching
 * the health record.
 */

describe('normalizeFindings — untrusted enums', () => {
  it('drops a finding with a category that is not ours', () => {
    const { proposals } = normalizeFindings(
      { findings: [{ category: 'swimming_pool', workKind: 'replace' }] },
      DOC,
    );
    expect(proposals).toHaveLength(0);
  });

  it('falls back to unknown rather than guessing a work kind', () => {
    const { proposals } = normalizeFindings(
      { findings: [{ category: 'hvac', workKind: 'refurbished' }] },
      DOC,
    );
    expect(proposals[0].workKind).toBe('unknown');
  });

  it('falls back to other for an unrecognised document kind', () => {
    const { documentKind } = normalizeFindings({ documentKind: 'blueprint', findings: [] }, DOC);
    expect(documentKind).toBe('other');
  });

  it('survives findings that are not an array', () => {
    expect(normalizeFindings({ findings: 'none' }, DOC).proposals).toHaveLength(0);
    expect(normalizeFindings(null, DOC).proposals).toHaveLength(0);
  });
});

describe('pickDate', () => {
  it('normalizes to a calendar date', () => {
    expect(pickDate('March 4, 2021')).toBe('2021-03-04');
  });

  it('rejects a future date', () => {
    const nextYear = new Date().getFullYear() + 2;
    expect(pickDate(`${nextYear}-01-01`)).toBeNull();
  });

  it('rejects prose', () => {
    expect(pickDate('last spring sometime')).toBeNull();
    expect(pickDate('null')).toBeNull();
    expect(pickDate(undefined)).toBeNull();
  });
});

describe('pickMoney', () => {
  it('reads a formatted amount', () => {
    expect(pickMoney('$2,450.00')).toBe(2450);
  });

  it('rejects zero and negatives', () => {
    expect(pickMoney(0)).toBeNull();
    expect(pickMoney(-80)).toBeNull();
  });

  it('rejects an amount no component receipt would carry', () => {
    // A misplaced decimal should not become the property's largest expense.
    expect(pickMoney(9_400_000)).toBeNull();
  });
});

describe('normalizeFindings — amounts', () => {
  it('assigns the document total to a lone component with no line amount', () => {
    const { proposals } = normalizeFindings(
      { totalUsd: 2400, findings: [{ category: 'water_heater', workKind: 'replace' }] },
      DOC,
    );
    expect(proposals[0].amountUsd).toBe(2400);
  });

  it('refuses to split a multi-component total', () => {
    const { proposals } = normalizeFindings(
      {
        totalUsd: 9000,
        findings: [
          { category: 'water_heater', workKind: 'replace' },
          { category: 'hvac', workKind: 'replace' },
        ],
      },
      DOC,
    );
    // Guessing a split would put invented figures into the cost ledger.
    expect(proposals[0].amountUsd).toBeNull();
    expect(proposals[1].amountUsd).toBeNull();
  });

  it('keeps per-line amounts when the document has them', () => {
    const { proposals } = normalizeFindings(
      {
        totalUsd: 9000,
        findings: [
          { category: 'water_heater', workKind: 'replace', amountUsd: 2400 },
          { category: 'hvac', workKind: 'replace', amountUsd: 6600 },
        ],
      },
      DOC,
    );
    expect(proposals.map((p) => p.amountUsd)).toEqual([2400, 6600]);
  });
});

describe('normalizeFindings — dates and provenance', () => {
  it('falls back to the document date when a finding has none', () => {
    const { proposals } = normalizeFindings(
      { servicedAt: '2021-04-12', findings: [{ category: 'roof', workKind: 'replace' }] },
      DOC,
    );
    expect(proposals[0].servicedAt).toBe('2021-04-12');
  });

  it('prefers a finding date over the document date', () => {
    const { proposals } = normalizeFindings(
      {
        servicedAt: '2021-04-12',
        findings: [{ category: 'roof', workKind: 'replace', servicedAt: '2020-09-01' }],
      },
      DOC,
    );
    expect(proposals[0].servicedAt).toBe('2020-09-01');
  });

  it('carries the document identity onto every proposal', () => {
    const { proposals } = normalizeFindings(
      { vendor: 'Tidewater Plumbing', findings: [{ category: 'plumbing', workKind: 'repair' }] },
      DOC,
    );
    expect(proposals[0].documentId).toBe('doc1');
    expect(proposals[0].documentName).toBe('Invoice.pdf');
    expect(proposals[0].vendor).toBe('Tidewater Plumbing');
  });

  it('clamps a confidence outside the unit range', () => {
    const { proposals } = normalizeFindings(
      {
        findings: [
          { category: 'roof', workKind: 'replace', confidence: 4 },
          { category: 'hvac', workKind: 'replace', confidence: -1 },
        ],
      },
      DOC,
    );
    expect(proposals[0].confidence).toBe(1);
    expect(proposals[1].confidence).toBe(0);
  });
});
