import { describe, expect, it } from 'vitest';
import {
  buildPropertyHistoryTimeline,
  groupTimelineByYear,
} from '../propertyHealthTimeline';
import { createEmptyHealthAsset, type PropertyHealthAsset } from '../../types/propertyHealth';
import type { BuildingPermit } from '../../types/attom';

function asset(over: Partial<PropertyHealthAsset> = {}): PropertyHealthAsset {
  return createEmptyHealthAsset({
    category: 'water_heater',
    name: 'Water heater',
    ...over,
  });
}

describe('buildPropertyHistoryTimeline', () => {
  it('records an install from the component inventory', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [asset({ installedAt: '2019-05-04', make: 'Rheem', model: 'XE50' })],
    });

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('install');
    expect(events[0].occurredAt).toBe('2019-05-04');
    expect(events[0].detail).toBe('Rheem XE50');
  });

  it('orders newest first', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [
        asset({ installedAt: '2019-05-04' }),
        createEmptyHealthAsset({ category: 'roof', name: 'Roof', installedAt: '2023-08-01' }),
      ],
    });

    expect(events.map((event) => event.occurredAt)).toEqual(['2023-08-01', '2019-05-04']);
  });

  it('lists each repair separately', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [
        asset({
          installedAt: '2015-01-01',
          spend: [
            { id: 's1', occurredAt: '2022-03-01', amountUsd: 180, workKind: 'repair', createdAt: '2022-03-01' },
            { id: 's2', occurredAt: '2024-07-15', amountUsd: 320, workKind: 'repair', createdAt: '2024-07-15' },
          ],
        }),
      ],
    });

    expect(events.filter((event) => event.kind === 'repair')).toHaveLength(2);
    expect(events[0].amountUsd).toBe(320);
  });

  it('does not list a replacement twice when it also produced the install date', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [
        asset({
          installedAt: '2021-04-12',
          spend: [
            { id: 's1', occurredAt: '2021-04-12', amountUsd: 2400, workKind: 'replace', vendor: 'Tidewater', createdAt: '2021-04-12' },
          ],
        }),
      ],
    });

    expect(events).toHaveLength(1);
    // The cost lands on the install rather than becoming a second entry.
    expect(events[0].kind).toBe('install');
    expect(events[0].amountUsd).toBe(2400);
    expect(events[0].vendor).toBe('Tidewater');
  });

  it('keeps an earlier replacement that is not the current install', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [
        asset({
          installedAt: '2021-04-12',
          spend: [
            { id: 's1', occurredAt: '2021-04-12', amountUsd: 2400, workKind: 'replace', createdAt: '2021-04-12' },
            { id: 's0', occurredAt: '2006-02-02', amountUsd: 900, workKind: 'replace', createdAt: '2006-02-02' },
          ],
        }),
      ],
    });

    expect(events).toHaveLength(2);
    expect(events[1].occurredAt).toBe('2006-02-02');
  });
});

describe('buildPropertyHistoryTimeline — permits', () => {
  const roofPermit: BuildingPermit = {
    source: 'attom',
    permit_number: 'P-1',
    permit_type: 'Roofing',
    permit_type_description: 'Reroof existing dwelling',
    issue_date: '2023-06-01',
    work_description: 'Tear off and replace asphalt shingles',
    contractor_company: 'Coastal Roofing',
    estimated_cost: 18000,
  };

  it('includes a permit that stands alone', () => {
    const events = buildPropertyHistoryTimeline({ assets: [], permits: [roofPermit] });

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('permit');
    expect(events[0].category).toBe('roof');
    expect(events[0].amountUsd).toBe(18000);
  });

  it('folds a permit into an install describing the same work', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [createEmptyHealthAsset({ category: 'roof', name: 'Roof', installedAt: '2023-08-14' })],
      permits: [roofPermit],
    });

    // One roof, not two.
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('install');
    expect(events[0].corroboratedBy).toBe('Reroof existing dwelling');
    expect(events[0].vendor).toBe('Coastal Roofing');
  });

  it('keeps a permit separate from an unrelated component', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [asset({ installedAt: '2023-08-14' })],
      permits: [roofPermit],
    });
    expect(events).toHaveLength(2);
  });

  it('keeps a permit separate from an install years apart', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [createEmptyHealthAsset({ category: 'roof', name: 'Roof', installedAt: '2009-01-01' })],
      permits: [roofPermit],
    });
    expect(events).toHaveLength(2);
  });

  it('skips a permit with no usable date', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [],
      permits: [{ ...roofPermit, issue_date: undefined }],
    });
    expect(events).toHaveLength(0);
  });
});

describe('buildPropertyHistoryTimeline — maintenance visits', () => {
  it('includes a completed visit and credits the technician', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [],
      serviceRecords: [
        {
          requestId: 'req1',
          completedAt: '2025-02-11T14:00:00.000Z',
          category: 'Plumbing',
          serviceType: 'Leak repair',
          providerName: 'Bay Mechanical',
          workPerformed: 'Replaced supply line',
          totals: { total: 245 },
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('service');
    expect(events[0].category).toBe('plumbing');
    expect(events[0].evidence).toBe('service');
    expect(events[0].amountUsd).toBe(245);
    expect(events[0].occurredAt).toBe('2025-02-11');
  });

  it('infers a category from the service text', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [],
      serviceRecords: [
        { requestId: 'r', completedAt: '2025-01-01', serviceType: 'Furnace not igniting' },
      ],
    });
    expect(events[0].category).toBe('hvac');
  });

  it('leaves the category unset when the text says nothing', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [],
      serviceRecords: [{ requestId: 'r', completedAt: '2025-01-01', serviceType: 'General visit' }],
    });
    expect(events[0].category).toBeUndefined();
  });
});

describe('groupTimelineByYear', () => {
  it('groups newest year first and totals spend', () => {
    const events = buildPropertyHistoryTimeline({
      assets: [
        asset({
          installedAt: '2019-05-04',
          spend: [
            { id: 's1', occurredAt: '2024-01-10', amountUsd: 200, workKind: 'repair', createdAt: '2024-01-10' },
            { id: 's2', occurredAt: '2024-09-02', amountUsd: 350, workKind: 'repair', createdAt: '2024-09-02' },
          ],
        }),
      ],
    });

    const groups = groupTimelineByYear(events);
    expect(groups[0].year).toBe(2024);
    expect(groups[0].spendUsd).toBe(550);
    expect(groups[0].events).toHaveLength(2);
    expect(groups[1].year).toBe(2019);
  });

  it('handles an empty timeline', () => {
    expect(groupTimelineByYear([])).toEqual([]);
  });
});
