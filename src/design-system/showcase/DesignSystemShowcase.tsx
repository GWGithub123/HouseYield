import { useState } from 'react';
import { Wallet, ReceiptText, FileBarChart } from 'lucide-react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { CardHeader } from '../components/CardHeader';
import { Drawer } from '../components/Drawer';
import { ExpandIcon } from '../components/ExpandIcon';
import { Field, SelectInput, TextArea, TextInput, Toggle } from '../components/FormControls';
import { GlossaryTip } from '../components/GlossaryTip';
import { IconButton } from '../components/IconButton';
import { KpiStrip } from '../components/KpiStrip';
import { KpiTile } from '../components/KpiTile';
import { Modal } from '../components/Modal';
import { SectionDivider } from '../components/SectionDivider';
import { SectionGroupHeader } from '../components/SectionGroupHeader';
import { SectionHeader } from '../components/SectionHeader';
import { ShowcaseSurface } from '../components/ShowcaseSurface';
import { Skeleton, SkeletonCard, SkeletonKpiStrip } from '../components/Skeleton';
import { Stat } from '../components/Stat';
import { SubTabs } from '../components/SubTabs';
import { TileGrid } from '../components/TileGrid';
import { ToastProvider, useToast } from '../components/Toast';
import {
  formatCurrency,
  formatCurrencyCompact,
  formatCurrencyExact,
  formatDelta,
  formatPercent,
  formatRelativeTime,
} from '../formatters';

/**
 * DesignSystemShowcase — the living reference for the HouseYield design
 * standard. Every sanctioned pattern appears here; if a pattern isn't here,
 * don't invent it on a page.
 */
function ShowcaseBody() {
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [subTab, setSubTab] = useState<'summary' | 'transactions' | 'reports'>('summary');
  const [toggleOn, setToggleOn] = useState(true);

  return (
    <div className="ds-surface min-h-screen px-6 py-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header>
          <div className="ds-eyebrow">Design System</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[color:var(--ds-text-primary)]">
            HouseYield UI standard
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[color:var(--ds-text-muted)]">
            One light, flat visual language built from the Bookkeeping/Tax pattern. Big readable
            numbers, labeled sections, laptop-first grids — for 45+ mom-and-pop landlords.
          </p>
        </header>

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader
          title="Hero numbers — KpiStrip"
          hint="The first and largest thing on every page: 3–4 key figures in a gap-px grid. Color only for meaning."
        />
        <KpiStrip
          items={[
            { label: 'Rental income', value: formatCurrencyExact(62200), sub: '2025-01-01 – 2026-07-06' },
            { label: 'Total expenses', value: formatCurrencyExact(43171.48), sub: 'Operating costs' },
            { label: 'Net income', value: formatCurrencyExact(19028.52), sub: 'Profitable period', tone: 'positive', toneValue: true },
          ]}
        />

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader title="Secondary metrics — Stat + KpiTile" accent="sky" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Rental income" value={formatCurrency(62200)} hint="Line 3" />
          <Stat label="Total expenses" value={formatCurrency(60153)} hint="Lines 5–19" />
          <Stat label="Depreciation" value={formatCurrency(16982)} hint="1 asset" active />
          <Stat label="Net income / loss" value={formatCurrency(2047)} hint="Schedule E line 26" />
        </div>
        <TileGrid minTile={180}>
          <KpiTile surface="light" label="Occupied" value="3" sub="Active tenant records" accent="var(--ds-success)" />
          <KpiTile surface="light" label="Pending rent" value={formatCurrency(4200)} sub="2 open requests" accent="var(--ds-warn)" />
          <KpiTile
            surface="light"
            label="Net cash flow"
            value={formatCurrency(12480)}
            delta={{ value: formatDelta(8.2, { kind: 'percent' }), direction: 'up', caption: 'YoY' }}
          />
        </TileGrid>

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader
          title="Showcase surface — one per view"
          accent="indigo"
          hint="The only sanctioned dark accent: a hero chart or featured KPI cluster with the sharp lit border ring. Never tables, forms, or text-heavy content."
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <ShowcaseSurface eyebrow="Environment" title="Humidity — mold zone" action={<Badge tone="warn" dot>Watch</Badge>}>
            <div className="flex h-36 items-end gap-1.5">
              {[42, 45, 44, 48, 52, 55, 58, 61, 63, 60, 57, 54].map((v, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-t"
                  style={{
                    height: `${v}%`,
                    background: v >= 55 ? 'linear-gradient(180deg, #34d399, #10b98155)' : 'rgba(148, 197, 255, 0.45)',
                  }}
                />
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-300">
              Green marks time spent in the mold-favorable zone (over 55% RH).
            </p>
          </ShowcaseSurface>
          <ShowcaseSurface
            tone="light"
            eyebrow="Featured metric"
            title="Portfolio value"
            action={<IconButton label="Expand"><ExpandIcon /></IconButton>}
          >
            <div className="text-3xl font-bold tabular-nums tracking-tight text-slate-900">
              {formatCurrency(3274590)}
            </div>
            <p className="mt-1 text-sm text-slate-500">
              {formatDelta(4.7, { kind: 'percent' })} over 12 months · updated {formatRelativeTime(Date.now() - 3 * 60_000)}
            </p>
          </ShowcaseSurface>
        </div>

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader title="Cards & section chrome" accent="emerald" />
        <SectionHeader label="Section header" description="Label + one-line plain-English description; actions on the right." />
        <div className="grid gap-4 lg:grid-cols-2">
          <Card surface="light" flushBody>
            <CardHeader
              title="Income & expenses"
              subtitle="From transactions recorded in your ledger. Share with your CPA to prepare your return."
              eyebrow="Schedule E — 2025"
              info="The IRS form where rental income and expenses are reported on your personal tax return."
              right={<Button size="sm">Download</Button>}
            />
            <div className="ds-card-divider px-5 py-3 text-sm text-slate-600">Rents received · {formatCurrency(62200)}</div>
            <div className="ds-card-divider px-5 py-3 text-sm text-slate-600">Repairs · {formatCurrency(2700)}</div>
          </Card>
          <Card surface="light" eyebrow="Tenants" title="Workspace card" action={<Badge tone="neutral">Preview</Badge>}>
            <p className="mb-4 text-[13px] leading-relaxed text-[color:var(--ds-text-muted)]">
              Cards wrap tab content; page identity stays in the pinned WorkspaceTabsHeader. Jargon
              gets a glossary tip <GlossaryTip term="NOI" explanation="Net Operating Income — rental income minus operating expenses, before mortgage payments and taxes." /> instead of going unexplained.
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success" dot>Active</Badge>
              <Badge tone="warn" dot>Screening</Badge>
              <Badge tone="danger" dot>Overdue</Badge>
              <Badge tone="info">Info</Badge>
            </div>
          </Card>
        </div>
        <SectionDivider label="Plain divider" />

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader title="Sub-tabs — 2–3 task views inside a page tab" accent="violet" />
        <SubTabs
          tabs={[
            { id: 'summary', label: 'Summary', icon: Wallet, accent: 'emerald', description: 'Key numbers at a glance' },
            { id: 'transactions', label: 'Transactions', icon: ReceiptText, accent: 'sky', description: 'The ledger' },
            { id: 'reports', label: 'Reports', icon: FileBarChart, accent: 'violet', description: 'Downloads' },
          ]}
          activeId={subTab}
          onChange={setSubTab}
        />
        <p className="text-xs text-slate-500">Active: {subTab}</p>

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader title="Buttons — one hierarchy" accent="amber" />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary">Primary — one per view</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="tertiary">Tertiary</Button>
          <Button variant="destructive" onClick={() => toast({ title: 'Sensor deleted', tone: 'neutral', action: { label: 'Undo', onClick: () => toast({ title: 'Sensor restored', tone: 'success' }) } })}>
            Destructive (with undo)
          </Button>
          <Button variant="secondary" loading>Loading</Button>
          <Button variant="secondary" disabled>Disabled</Button>
        </div>

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader title="Forms" accent="sky" />
        <Card surface="light">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Property address" hint="Street, city, state" htmlFor="demo-address">
              <TextInput id="demo-address" placeholder="11822 Prestwick Road" />
            </Field>
            <Field label="Lease term" htmlFor="demo-term">
              <SelectInput id="demo-term" defaultValue="12">
                <option value="6">6 months</option>
                <option value="12">12 months</option>
                <option value="24">24 months</option>
              </SelectInput>
            </Field>
            <Field label="Notes" className="sm:col-span-2" error={undefined}>
              <TextArea placeholder="Anything your future self should know…" rows={3} />
            </Field>
            <Toggle checked={toggleOn} onChange={setToggleOn} label="Email me a weekly recap" />
          </div>
        </Card>

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader title="Overlays & feedback" accent="rose" />
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setModalOpen(true)}>Open modal</Button>
          <Button onClick={() => setDrawerOpen(true)}>Open drawer</Button>
          <Button onClick={() => toast({ tone: 'success', title: 'Payment recorded', description: `${formatCurrency(2100)} from 11822 Prestwick Road` })}>
            Success toast
          </Button>
        </div>

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader title="Loading — skeletons match the coming layout" />
        <SkeletonKpiStrip columns={3} />
        <div className="grid gap-4 lg:grid-cols-2">
          <SkeletonCard lines={3} />
          <Card surface="light" title="Inline skeleton bits">
            <div className="space-y-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </div>
          </Card>
        </div>

        {/* ------------------------------------------------------------- */}
        <SectionGroupHeader title="Formatters — one way to write every value" />
        <Card surface="light" flushBody>
          <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-3">
            {[
              ['formatCurrency', formatCurrency(3274590)],
              ['formatCurrencyExact', formatCurrencyExact(19028.52)],
              ['formatCurrencyCompact', formatCurrencyCompact(3274590)],
              ['formatPercent', formatPercent(0.053)],
              ['formatDelta', formatDelta(-4.7, { kind: 'percent' })],
              ['formatRelativeTime', formatRelativeTime(Date.now() - 3 * 60_000)],
            ].map(([name, value]) => (
              <div key={name as string} className="bg-white px-5 py-4">
                <div className="ds-label">{name}</div>
                <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{value}</div>
              </div>
            ))}
          </div>
        </Card>

        <Modal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title="Request a payment"
          subtitle="The tenant gets an email with a secure payment link."
          footer={
            <>
              <Button variant="tertiary" onClick={() => setModalOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => { setModalOpen(false); toast({ tone: 'success', title: 'Payment request sent' }); }}>
                Send request
              </Button>
            </>
          }
        >
          <Field label="Amount" htmlFor="demo-amount">
            <TextInput id="demo-amount" defaultValue="$2,100.00" />
          </Field>
        </Modal>

        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="Maintenance request"
          subtitle="Flood Sensor d3c830 · 11822 Prestwick Road"
          footer={<Button variant="primary" onClick={() => setDrawerOpen(false)}>Mark resolved</Button>}
        >
          <div className="space-y-3 text-sm text-slate-600">
            <p>Water detected in the bathroom. Tenant notified Jul 5, 3:04 PM.</p>
            <Badge tone="danger" dot>Critical</Badge>
          </div>
        </Drawer>
      </div>
    </div>
  );
}

export default function DesignSystemShowcase() {
  return (
    <ToastProvider>
      <ShowcaseBody />
    </ToastProvider>
  );
}
