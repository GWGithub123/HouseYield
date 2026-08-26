/**
 * Development-time layout harness for the new Property Health sections.
 *
 * These three carry the layouts most likely to break: the cost ledger puts a
 * table inside a rounded card, which is where horizontal overflow shows up, and
 * the timeline has a two-column row with a money figure pinned right that a long
 * work description can push out of its column.
 *
 * Not an assertion test. It only has to not throw. `scripts/shoot-preview.mjs`
 * builds the stylesheet and photographs the result.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';
import ComponentCostLedger from '../ComponentCostLedger';
import PropertyHistoryTimeline from '../PropertyHistoryTimeline';
import { buildPropertyHistoryTimeline } from '../../../services/propertyHealthTimeline';
import { summarizeComponentCosts } from '../../../services/propertyHealthDocuments';
import { createEmptyHealthAsset, type PropertyHealthAsset } from '../../../types/propertyHealth';
import type { BuildingPermit } from '../../../types/attom';

const OUT = 'tmp-preview';

/**
 * A property with the awkward cases in it deliberately: a component whose
 * repairs have overtaken replacement, a very long work description, and a
 * permit that corroborates an install.
 */
function fixtureAssets(): PropertyHealthAsset[] {
  return [
    createEmptyHealthAsset({
      category: 'water_heater',
      name: 'Water heater',
      make: 'Rheem',
      model: 'XE50T10H45U0',
      installedAt: '2013-06-18',
      evidence: 'document',
      spend: [
        { id: 'w1', occurredAt: '2013-06-18', amountUsd: 1180, workKind: 'replace', vendor: 'Tidewater Plumbing', createdAt: '2013-06-18' },
        { id: 'w2', occurredAt: '2023-02-04', amountUsd: 940, workKind: 'repair', vendor: 'Tidewater Plumbing', description: 'Replaced thermostat and upper heating element after no-hot-water call', createdAt: '2023-02-04' },
        { id: 'w3', occurredAt: '2025-11-09', amountUsd: 1120, workKind: 'repair', vendor: 'Bay Mechanical Services of Sussex County', description: 'Anode rod and lower element; tank showing early corrosion at the base seam, recommended replacement within eighteen months', createdAt: '2025-11-09' },
      ],
    }),
    createEmptyHealthAsset({
      category: 'roof',
      name: 'Architectural shingle roof',
      installedAt: '2023-08-14',
      evidence: 'owner',
      spend: [
        { id: 'r1', occurredAt: '2023-08-14', amountUsd: 18400, workKind: 'replace', vendor: 'Coastal Roofing', createdAt: '2023-08-14' },
      ],
    }),
    createEmptyHealthAsset({
      category: 'hvac',
      name: 'Heat pump',
      make: 'Carrier',
      installedAt: '2018-04-02',
      evidence: 'permit',
      spend: [
        { id: 'h1', occurredAt: '2024-05-20', amountUsd: 285, workKind: 'service', vendor: 'Atlantic Air', description: 'Annual service', createdAt: '2024-05-20' },
      ],
    }),
    createEmptyHealthAsset({
      category: 'air_filter',
      name: 'Return air filter',
      installedAt: '2026-05-01',
    }),
  ];
}

const PERMITS: BuildingPermit[] = [
  {
    source: 'attom',
    permit_number: 'SUS-2023-04412',
    permit_type: 'Roofing',
    permit_type_description: 'Reroof existing dwelling',
    issue_date: '2023-06-27',
    work_description: 'Tear off existing and install architectural shingles over synthetic underlayment',
    contractor_company: 'Coastal Roofing',
    estimated_cost: 18000,
  },
  {
    source: 'attom',
    permit_number: 'SUS-2011-00981',
    permit_type: 'Electrical',
    permit_type_description: 'Service panel upgrade',
    issue_date: '2011-03-14',
    work_description: 'Upgrade 100A panel to 200A',
    contractor_company: 'Shore Electric',
  },
];

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body class="bg-slate-100 p-6">
    <div class="mx-auto max-w-[1400px] space-y-5">${body}</div>
  </body>
</html>`;
}

describe('property health layout harness', () => {
  it('writes the cost ledger and history timeline pages', () => {
    mkdirSync(OUT, { recursive: true });

    const assets = fixtureAssets();
    const summaries = summarizeComponentCosts(assets).filter((s) => s.eventCount > 0);
    const events = buildPropertyHistoryTimeline({ assets, permits: PERMITS });

    writeFileSync(
      `${OUT}/health-cost-ledger.html`,
      page(
        'Cost ledger',
        renderToStaticMarkup(<ComponentCostLedger summaries={summaries} />),
      ),
    );

    writeFileSync(
      `${OUT}/health-timeline.html`,
      page(
        'History timeline',
        renderToStaticMarkup(<PropertyHistoryTimeline events={events} />),
      ),
    );

    // Both together, since on the real page they stack and the widths have to agree.
    writeFileSync(
      `${OUT}/health-stack.html`,
      page(
        'Health stack',
        renderToStaticMarkup(
          <>
            <ComponentCostLedger summaries={summaries} />
            <PropertyHistoryTimeline events={events} />
          </>,
        ),
      ),
    );
  });
});
