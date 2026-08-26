/**
 * Development-time layout harness for the Properties overview shell.
 *
 * Unlike the twin's SVG preview, this one has to go through a real browser:
 * everything worth checking here — whether the fact rail leaves dead space
 * beside the visual, whether a long lender name pushes a panel out of its
 * column — is Tailwind flex and grid behaviour that only exists once CSS is
 * applied. So this writes markup, and `scripts/shoot-preview.mjs` builds the
 * stylesheet and photographs it at a few widths.
 *
 * Not an assertion test. It only has to not throw.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it } from 'vitest';
import { PropertyTwinCard } from '../PropertyTwinCard';
import { FactPanel, FactRow, FactPanelEmpty } from '../PropertyFactPanel';

const OUT = 'tmp-preview';

/** Stands in for Street View, which needs a network key and a live <img>. */
function VisualStub({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-200 to-slate-300">
      <span className="text-sm font-bold uppercase tracking-[0.2em] text-slate-500">{label}</span>
    </div>
  );
}

/**
 * The mortgage panel is the tall one and the context panel is the short one,
 * which is the pairing that produced the ragged column in the first place, so
 * the harness always renders the real row counts rather than even stubs.
 */
function facts(over: { mortgage?: boolean } = {}) {
  return (
    <>
      <FactPanel label="Valuation" dotColor="#10b981">
        <FactRow label="AVM:" value="$1,139,811" />
        <FactRow label="Range:" nowrap valueClassName="font-medium text-slate-700" value="$1,048,626 – $1,230,995" />
        <FactRow label="Assessed:" value="—" />
        <FactRow label="$/SqFt:" value="$481" />
      </FactPanel>

      <FactPanel label="Property" dotColor="#6366f1">
        <FactRow label="Beds / Baths:" nowrap value="— / 3" />
        <FactRow label="SqFt:" value="2,368" />
        <FactRow label="Year Built:" value="1968" />
        <FactRow label="Age:" value="58 yrs" />
      </FactPanel>

      <FactPanel label="Mortgage" dotColor="#8b5cf6">
        {over.mortgage === false ? (
          <FactPanelEmpty>No mortgage data</FactPanelEmpty>
        ) : (
          <>
            <FactRow label="Lender:" value="PROSPERITY HOME MORTGAGE LLC" />
            <FactRow label="Amount:" value="$595,000" />
            <FactRow label="Est. Rate:" valueClassName="text-blue-600" value="5.27%" />
            <FactRow label="Type / Term:" nowrap value="CNV / 360mo" />
            <FactRow label="Originated:" nowrap value="5/4/2022" />
            <FactRow label="Assumable:" valueClassName="text-rose-600" value="Unlikely" />
          </>
        )}
      </FactPanel>

      <FactPanel label="Context" dotColor="#14b8a6">
        <FactRow label="County:" value="Montgomery" />
        <FactRow label="Zoning:" value="Residential" />
        <FactRow label="Tax Area:" value="53" />
        <FactRow label="Schools:" value={3} />
      </FactPanel>
    </>
  );
}

const VIEWS = [
  { id: 'street' as const, label: 'Street view' },
  { id: 'map' as const, label: 'Holdings map' },
  { id: 'trend' as const, label: 'Value trend' },
];

function card(view: 'street' | 'map' | 'trend', over: { mortgage?: boolean } = {}) {
  return renderToStaticMarkup(
    <PropertyTwinCard
      title="11822 Prestwick Rd, Potomac, MD 20854"
      headerRight={
        <>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700">
            Second home
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-slate-600">
            2 holdings
          </span>
        </>
      }
      views={VIEWS}
      view={view}
      onViewChange={() => {}}
      visual={<VisualStub label={view} />}
      visualFooter={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-[11px] font-bold tracking-wide text-slate-700">
            Add images · 0/25
          </label>
        </div>
      }
      facts={facts(over)}
      footer={
        <>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-2.5 text-sm text-slate-700">
            <span className="font-semibold">Griffin White</span>
            <span className="rounded-lg bg-purple-600 px-3 py-1 text-xs font-bold text-white">+ Onboard</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-2.5 text-sm text-slate-700">
            <span className="font-semibold">Community &amp; Schools · 3 nearby</span>
            <span className="rounded-lg border border-blue-200 px-3 py-1 text-xs font-bold text-blue-700">View Details</span>
          </div>
        </>
      }
    />,
  );
}

/**
 * The value and tax charts as they sit under the card for a non-rental. These
 * are the pair that collapsed to a twelfth of the width when they were dropped
 * into the 12-column grid without a span, so the harness renders them in place
 * rather than on their own.
 */
function chartsStrip() {
  return `
    <div class="mt-4">
      <div class="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <div class="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">History</div>
          <h3 class="text-sm font-semibold text-slate-900">Value and taxes</h3>
        </div>
      </div>
      <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <div class="min-h-[260px] rounded-2xl border border-slate-200 bg-white p-4">
          <div class="text-sm font-semibold text-slate-900">Price history</div>
          <div class="mt-2 h-[200px] rounded-lg bg-slate-100"></div>
        </div>
        <div class="min-h-[260px] rounded-2xl border border-slate-200 bg-white p-4">
          <div class="text-sm font-semibold text-slate-900">Tax history</div>
          <div class="mt-2 h-[200px] rounded-lg bg-slate-100"></div>
        </div>
      </div>
    </div>`;
}

function page(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="./app.css" />
  </head>
  <body class="bg-slate-50">
    <div class="mx-auto max-w-[1600px] p-6">${body}</div>
  </body>
</html>`;
}

describe('properties overview preview', () => {
  it('renders to html', () => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/overview-street.html`, page(card('street') + chartsStrip()));
    writeFileSync(`${OUT}/overview-map.html`, page(card('map')));
    writeFileSync(`${OUT}/overview-trend.html`, page(card('trend')));
    // No mortgage shortens the tall panel, which is when the rail is most
    // likely to come up short against the visual.
    writeFileSync(`${OUT}/overview-no-mortgage.html`, page(card('street', { mortgage: false })));
  });
});
