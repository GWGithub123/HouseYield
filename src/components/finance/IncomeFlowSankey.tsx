import { useId, useMemo, useState } from 'react';
import { sankey, sankeyLinkHorizontal, type SankeyGraph } from 'd3-sankey';

export type IncomeFlowSegment = {
  key: string;
  label: string;
  shortLabel: string;
  value: number;
  sourceType: 'rental' | 'stock' | 'bond';
  color: string;
};

type IncomeFlowSankeyProps = {
  segments: IncomeFlowSegment[];
  totalAnnual: number;
  formatCurrency: (value: number) => string;
  /** Maximum number of individual leaf nodes before the remainder is grouped into "Other". */
  maxLeafNodes?: number;
};

type SankeyNodeDatum = {
  id: string;
  name: string;
  kind: 'root' | 'category' | 'leaf';
  color: string;
  value: number;
};

type SankeyLinkDatum = {
  source: number;
  target: number;
  value: number;
  color: string;
};

const CATEGORY_META: Record<string, { name: string; color: string }> = {
  rental: { name: 'Rental Income', color: '#14b8a6' },
  dividend: { name: 'Dividend Income', color: '#6366f1' },
};

const ROOT_COLOR = '#0f172a';
const OTHER_COLOR = '#94a3b8';

/**
 * Monarch-style income cash-flow visualization. A single "Annual Income" source
 * fans out into income categories and then into the individual holdings / properties
 * that generate it, with gradient links colored from source to destination.
 */
export default function IncomeFlowSankey({
  segments,
  totalAnnual,
  formatCurrency,
  maxLeafNodes = 9,
}: IncomeFlowSankeyProps) {
  const rawId = useId();
  const gradientBase = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const [hovered, setHovered] = useState<string | null>(null);

  const graph = useMemo(() => {
    const positive = segments.filter((segment) => segment.value > 0);
    if (positive.length === 0 || totalAnnual <= 0) {
      return null;
    }

    const nodes: SankeyNodeDatum[] = [];
    const links: SankeyLinkDatum[] = [];
    const indexById = new Map<string, number>();

    const addNode = (node: SankeyNodeDatum) => {
      const idx = nodes.length;
      nodes.push(node);
      indexById.set(node.id, idx);
      return idx;
    };

    const rootIdx = addNode({ id: 'root', name: 'Annual Income', kind: 'root', color: ROOT_COLOR, value: 0 });

    const categoryFor = (segment: IncomeFlowSegment): 'rental' | 'dividend' =>
      segment.sourceType === 'rental' ? 'rental' : 'dividend';

    // Group leaves by category, preserving the value-sorted order.
    const byCategory = new Map<'rental' | 'dividend', IncomeFlowSegment[]>();
    positive
      .slice()
      .sort((a, b) => b.value - a.value)
      .forEach((segment) => {
        const cat = categoryFor(segment);
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push(segment);
      });

    // Order: rental first, then dividend, for stable visual layout.
    const orderedCategories: Array<'rental' | 'dividend'> = (['rental', 'dividend'] as const).filter((cat) =>
      byCategory.has(cat),
    );

    orderedCategories.forEach((cat) => {
      const catSegments = byCategory.get(cat)!;
      const catTotal = catSegments.reduce((sum, segment) => sum + segment.value, 0);
      const meta = CATEGORY_META[cat];
      const catIdx = addNode({ id: `cat-${cat}`, name: meta.name, kind: 'category', color: meta.color, value: catTotal });
      links.push({ source: rootIdx, target: catIdx, value: catTotal, color: meta.color });

      // Cap leaves so the diagram stays legible; remainder rolls into "Other".
      const visible = catSegments.slice(0, maxLeafNodes);
      const overflow = catSegments.slice(maxLeafNodes);

      visible.forEach((segment) => {
        const leafIdx = addNode({
          id: `leaf-${segment.key}`,
          name: segment.shortLabel || segment.label,
          kind: 'leaf',
          color: segment.color || meta.color,
          value: segment.value,
        });
        links.push({ source: catIdx, target: leafIdx, value: segment.value, color: segment.color || meta.color });
      });

      if (overflow.length > 0) {
        const overflowValue = overflow.reduce((sum, segment) => sum + segment.value, 0);
        const leafIdx = addNode({
          id: `leaf-other-${cat}`,
          name: `+${overflow.length} more`,
          kind: 'leaf',
          color: OTHER_COLOR,
          value: overflowValue,
        });
        links.push({ source: catIdx, target: leafIdx, value: overflowValue, color: OTHER_COLOR });
      }
    });

    const leafCount = nodes.filter((node) => node.kind === 'leaf').length;
    const width = 760;
    // Compact, secondary sizing: keep the diagram from dominating the page.
    const height = Math.min(360, Math.max(200, leafCount * 34 + 28));

    const layout = sankey<SankeyNodeDatum, SankeyLinkDatum>()
      .nodeWidth(14)
      .nodePadding(12)
      .extent([
        [8, 12],
        [width - 8, height - 12],
      ]);

    const sankeyData: SankeyGraph<SankeyNodeDatum, SankeyLinkDatum> = layout({
      nodes: nodes.map((node) => ({ ...node })),
      links: links.map((link) => ({ ...link })),
    });

    return { ...sankeyData, width, height };
  }, [segments, totalAnnual, maxLeafNodes]);

  if (!graph) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/60 text-sm text-slate-400">
        Add dividend holdings or rental properties to visualize your income flow.
      </div>
    );
  }

  const linkPath = sankeyLinkHorizontal<SankeyNodeDatum, SankeyLinkDatum>();
  const isDim = (id: string) => hovered !== null && hovered !== id;

  return (
    <div className="w-full overflow-x-auto" data-voice-id="income-flow-sankey">
      <svg
        viewBox={`0 0 ${graph.width} ${graph.height}`}
        width="100%"
        height={graph.height}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Income flow from annual income into categories and individual sources"
      >
        <defs>
          {graph.links.map((link, idx) => {
            const source = link.source as unknown as { x1: number; color: string };
            const target = link.target as unknown as { x0: number; color: string };
            return (
              <linearGradient
                key={`grad-${idx}`}
                id={`${gradientBase}-link-${idx}`}
                gradientUnits="userSpaceOnUse"
                x1={source.x1}
                x2={target.x0}
              >
                <stop offset="0%" stopColor={source.color} />
                <stop offset="100%" stopColor={target.color} />
              </linearGradient>
            );
          })}
        </defs>

        {graph.links.map((link, idx) => {
          const target = link.target as unknown as SankeyNodeDatum & { x0: number };
          const source = link.source as unknown as SankeyNodeDatum;
          const dim = isDim(target.id) && isDim(source.id);
          return (
            <path
              key={`link-${idx}`}
              d={linkPath(link) || undefined}
              fill="none"
              stroke={`url(#${gradientBase}-link-${idx})`}
              strokeOpacity={dim ? 0.12 : 0.42}
              strokeWidth={Math.max(1, link.width ?? 1)}
              style={{ transition: 'stroke-opacity 0.2s ease' }}
              onMouseEnter={() => setHovered(target.id)}
              onMouseLeave={() => setHovered(null)}
            />
          );
        })}

        {graph.nodes.map((node, idx) => {
          const n = node as SankeyNodeDatum & { x0: number; x1: number; y0: number; y1: number };
          const nodeHeight = Math.max(2, (n.y1 ?? 0) - (n.y0 ?? 0));
          const nodeWidth = (n.x1 ?? 0) - (n.x0 ?? 0);
          const isLeft = n.kind === 'root';
          const labelX = isLeft ? (n.x1 ?? 0) + 10 : n.kind === 'category' ? (n.x1 ?? 0) + 10 : (n.x0 ?? 0) - 10;
          const anchor = n.kind === 'leaf' ? 'end' : 'start';
          const dim = isDim(n.id);
          const midY = (n.y0 ?? 0) + nodeHeight / 2;
          return (
            <g
              key={`node-${idx}`}
              style={{ transition: 'opacity 0.2s ease', opacity: dim ? 0.35 : 1, cursor: 'default' }}
              onMouseEnter={() => setHovered(n.id)}
              onMouseLeave={() => setHovered(null)}
            >
              <rect
                x={n.x0}
                y={n.y0}
                width={nodeWidth}
                height={nodeHeight}
                rx={Math.min(5, nodeWidth / 2)}
                fill={n.color}
              />
              <text
                x={labelX}
                y={midY - (nodeHeight > 30 ? 5 : 0)}
                dy="0.35em"
                textAnchor={anchor}
                fontSize={n.kind === 'root' ? 13 : 12}
                fontWeight={n.kind === 'leaf' ? 500 : 700}
                fill="#0f172a"
              >
                {n.name}
              </text>
              {nodeHeight > 26 && (
                <text
                  x={labelX}
                  y={midY + 11}
                  dy="0.35em"
                  textAnchor={anchor}
                  fontSize={11}
                  fontWeight={500}
                  fill="#94a3b8"
                >
                  {formatCurrency(n.value)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
