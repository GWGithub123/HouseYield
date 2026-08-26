import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as d3 from 'd3';

export type ComprehensiveAssetSankeyAllocation = {
  label: string;
  value: number;
  percentage: number;
  color: string;
  assetList: Array<{ name: string; value: number }>;
};

export default function ComprehensiveAssetSankey({
  allocations,
  totalValue,
  viewMode = 'assets',
  rootLabel,
  title,
  theme = 'light',
  height = 600,
}: {
  allocations: ComprehensiveAssetSankeyAllocation[];
  totalValue: number;
  viewMode?: 'assets' | 'equity';
  rootLabel?: string;
  title?: string;
  /** 'dark' renders a sleeker, Monarch-style dark canvas suited to embedding in a dark card. */
  theme?: 'light' | 'dark';
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gradientIdBase = useId().replace(/[^a-zA-Z0-9_-]/g, '-');
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const [hoveredLink, setHoveredLink] = useState<any>(null);

  const allocationSignature = useMemo(
    () => JSON.stringify(allocations.map((allocation) => ({
      label: allocation.label,
      value: allocation.value,
      percentage: allocation.percentage,
      color: allocation.color,
      assetList: allocation.assetList.map((asset) => ({ name: asset.name, value: asset.value })),
    }))),
    [allocations],
  );
  const stableAllocations = useMemo<ComprehensiveAssetSankeyAllocation[]>(
    () => JSON.parse(allocationSignature),
    [allocationSignature],
  );
  const rootValue = stableAllocations.filter((allocation) => allocation.value > 0).reduce((sum, allocation) => sum + allocation.value, 0);
  const effectiveRootLabel = rootLabel || (viewMode === 'equity' ? 'Net Worth' : 'Total Assets');

  const isDark = theme === 'dark';
  const labelColor = isDark ? '#e2e8f0' : '#1e293b';
  const subLabelColor = isDark ? '#94a3b8' : '#94a3b8';
  const titleColor = isDark ? '#f1f5f9' : '#0f172a';

  useEffect(() => {
    const width = 1400;
    const margin = { top: 52, right: 250, bottom: 32, left: 180 };

    if (!svgRef.current) return;
    d3.select(svgRef.current).selectAll('*').remove();

    const svg = d3.select(svgRef.current)
      .attr('width', width)
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .style('background', 'transparent');

    const activeAllocations = stableAllocations.filter((allocation) => allocation.value > 0);

    if (activeAllocations.length === 0 || rootValue === 0) {
      svg.append('text')
        .attr('x', width / 2)
        .attr('y', height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#9ca3af')
        .attr('font-size', '16px')
        .text('No assets to display');
      return;
    }

    const nodes: any[] = [];
    const links: any[] = [];
    let nodeId = 0;

    nodes.push({
      id: nodeId++,
        name: effectiveRootLabel,
      value: rootValue,
      x: 0,
      order: 0,
      color: '#3b82f6',
    });

    let classOrder = 0;
    activeAllocations.forEach((assetClass) => {
      const classNodeId = nodeId++;
      nodes.push({
        id: classNodeId,
        name: assetClass.label,
        value: assetClass.value,
        x: 1,
        order: classOrder++,
        color: assetClass.color,
      });

      links.push({
        source: 0,
        target: classNodeId,
        value: assetClass.value,
      });

      const sortedAssets = [...assetClass.assetList]
        .filter((asset) => asset.value > 0)
        .sort((left, right) => right.value - left.value);
      const topAssets = sortedAssets.slice(0, 5);
      const topSum = topAssets.reduce((sum, asset) => sum + asset.value, 0);
      const remainder = assetClass.value - topSum;

      topAssets.forEach((asset) => {
        const assetNodeId = nodeId++;
        nodes.push({
          id: assetNodeId,
          name: asset.name,
          value: asset.value,
          x: 2,
          order: nodes.filter((node) => node.x === 2).length,
          color: assetClass.color,
        });

        links.push({
          source: classNodeId,
          target: assetNodeId,
          value: asset.value,
        });
      });

      if (remainder > 1) {
        const otherCount = sortedAssets.length - topAssets.length;
        const assetNodeId = nodeId++;
        nodes.push({
          id: assetNodeId,
          name: otherCount > 0 ? `Other (${otherCount} more)` : 'Other',
          value: remainder,
          x: 2,
          order: nodes.filter((node) => node.x === 2).length,
          color: assetClass.color,
        });

        links.push({
          source: classNodeId,
          target: assetNodeId,
          value: remainder,
        });
      }
    });

    const nodeWidth = 28;
    const nodePadding = 16;
    const columnWidth = (width - margin.left - margin.right - nodeWidth * 3) / 2;
    const maxValuePerColumn = d3.max(d3.rollup(nodes, (value) => d3.sum(value, (node: any) => node.value), (node: any) => node.x).values());
    const availableHeight = height - margin.top - margin.bottom;
    const scale = availableHeight / ((maxValuePerColumn || 1) * 1.2);

    nodes.forEach((node: any) => {
      node.x0 = margin.left + node.x * columnWidth + node.x * nodeWidth;
      node.x1 = node.x0 + nodeWidth;
      node.height = Math.max(node.value * scale, 8);
    });

    const columns = d3.group(nodes, (node: any) => node.x);
    columns.forEach((columnNodes: any) => {
      columnNodes.sort((left: any, right: any) => left.order - right.order);
      const totalHeight = d3.sum(columnNodes, (node: any) => node.height);
      const padding = (columnNodes.length - 1) * nodePadding;
      const startY = margin.top + (availableHeight - totalHeight - padding) / 2;

      let currentY = startY;
      columnNodes.forEach((node: any) => {
        node.y0 = currentY;
        node.y1 = currentY + node.height;
        currentY = node.y1 + nodePadding;
      });
    });

    nodes.forEach((node: any) => {
      node.sourceY = node.y0;
      node.targetY = node.y0;
    });

    const linkData = links.map((link) => {
      const source = nodes.find((node) => node.id === link.source)!;
      const target = nodes.find((node) => node.id === link.target)!;
      const linkHeight = Math.max(link.value * scale, 4);

      const sourceY = source.sourceY;
      const targetY = target.targetY;

      source.sourceY += linkHeight;
      target.targetY += linkHeight;

      return {
        ...link,
        source,
        target,
        width: linkHeight,
        sy0: sourceY,
        sy1: sourceY + linkHeight,
        ty0: targetY,
        ty1: targetY + linkHeight,
      };
    });

    const defs = svg.append('defs');

    linkData.forEach((link, index) => {
      const gradientId = `${gradientIdBase}-asset-gradient-${index}`;
      const gradient = defs.append('linearGradient')
        .attr('id', gradientId)
        .attr('gradientUnits', 'userSpaceOnUse')
        .attr('x1', link.source.x1)
        .attr('x2', link.target.x0);

      gradient.append('stop')
        .attr('offset', '0%')
        .attr('stop-color', link.source.color)
        .attr('stop-opacity', 0.55);

      gradient.append('stop')
        .attr('offset', '50%')
        .attr('stop-color', d3.interpolateRgb(link.source.color, link.target.color)(0.5))
        .attr('stop-opacity', 0.3);

      gradient.append('stop')
        .attr('offset', '100%')
        .attr('stop-color', link.target.color)
        .attr('stop-opacity', 0.5);
    });

    const generateLinkPath = (link: any) => {
      const sourceX = link.source.x1;
      const targetX = link.target.x0;
      const curvature = 0.5;
      const xi = d3.interpolateNumber(sourceX, targetX);
      const x2 = xi(curvature);
      const x3 = xi(1 - curvature);

      return `
        M ${sourceX},${link.sy0}
        C ${x2},${link.sy0} ${x3},${link.ty0} ${targetX},${link.ty0}
        L ${targetX},${link.ty1}
        C ${x3},${link.ty1} ${x2},${link.sy1} ${sourceX},${link.sy1}
        Z
      `;
    };

    const link = svg.append('g')
      .selectAll('path')
      .data(linkData)
      .join('path')
      .attr('d', generateLinkPath)
      .attr('fill', (_link, index) => `url(#${gradientIdBase}-asset-gradient-${index})`)
      .attr('stroke', 'none')
      .attr('opacity', 0)
      .on('mouseover', function (_event: any, datum: any) {
        setHoveredLink(datum);
        d3.select(this as any)
          .transition()
          .duration(200)
          .attr('opacity', 0.85);
      })
      .on('mouseout', function () {
        setHoveredLink(null);
        d3.select(this as any)
          .transition()
          .duration(200)
          .attr('opacity', 0.55);
      });

    link.transition()
      .duration(900)
      .delay((_link: any, index: number) => index * 25)
      .attr('opacity', 0.55);

    const nodeGroup = svg.append('g');

    nodeGroup.selectAll('rect')
      .data(nodes)
      .join('rect')
      .attr('x', (node: any) => node.x0)
      .attr('y', (node: any) => node.y0)
      .attr('height', (node: any) => node.y1 - node.y0)
      .attr('width', (node: any) => node.x1 - node.x0)
      .attr('fill', (node: any) => node.color)
      .attr('opacity', 0)
      .attr('rx', 6)
      .style('cursor', 'pointer')
      .style('filter', 'drop-shadow(0 2px 6px rgba(15,23,42,0.12))')
      .on('mouseover', function (_event: any, datum: any) {
        setHoveredNode(datum);
        d3.select(this as any)
          .transition()
          .duration(200)
          .attr('opacity', 1)
          .style('filter', 'drop-shadow(0 6px 16px rgba(15,23,42,0.22))');
      })
      .on('mouseout', function () {
        setHoveredNode(null);
        d3.select(this as any)
          .transition()
          .duration(200)
          .attr('opacity', 0.95)
          .style('filter', 'drop-shadow(0 2px 6px rgba(15,23,42,0.12))');
      })
      .transition()
      .duration(800)
      .delay((_node: any, index: number) => index * 50)
      .attr('opacity', 0.95);

    svg.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .attr('x', (node: any) => {
        if (node.x === 0) return node.x0 - 12;
        if (node.x === 2) return node.x1 + 12;
        return node.x1 + 12;
      })
      .attr('y', (node: any) => (node.y1 + node.y0) / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', (node: any) => (node.x === 0 ? 'end' : 'start'))
      .attr('fill', labelColor)
      .attr('font-size', '13px')
      .attr('font-weight', '600')
      .attr('letter-spacing', '-0.01em')
      .attr('opacity', 0)
      .text((node: any) => node.name.length > 25 ? `${node.name.substring(0, 25)}...` : node.name)
      .transition()
      .duration(800)
      .delay((_node: any, index: number) => index * 50 + 400)
      .attr('opacity', 1);

    svg.append('g')
      .selectAll('text')
      .data(nodes)
      .join('text')
      .attr('x', (node: any) => {
        if (node.x === 0) return node.x0 - 12;
        if (node.x === 2) return node.x1 + 12;
        return node.x1 + 12;
      })
      .attr('y', (node: any) => (node.y1 + node.y0) / 2 + 18)
      .attr('dy', '0.35em')
      .attr('text-anchor', (node: any) => (node.x === 0 ? 'end' : 'start'))
      .attr('fill', subLabelColor)
      .attr('font-size', '11px')
      .attr('font-weight', '500')
      .attr('opacity', 0)
      .text((node: any) => {
        const percentage = ((node.value / rootValue) * 100).toFixed(1);
        return node.x === 0 ? `$${node.value.toLocaleString()}` : `$${node.value.toLocaleString()} (${percentage}%)`;
      })
      .transition()
      .duration(800)
      .delay((_node: any, index: number) => index * 50 + 500)
      .attr('opacity', 0.9);

    svg.append('rect')
      .attr('x', margin.left)
      .attr('y', 16)
      .attr('width', 4)
      .attr('height', 18)
      .attr('rx', 2)
      .attr('fill', 'url(#' + gradientIdBase + '-title-accent)');

    const titleAccent = defs.append('linearGradient')
      .attr('id', gradientIdBase + '-title-accent')
      .attr('x1', '0').attr('y1', '0').attr('x2', '0').attr('y2', '1');
    titleAccent.append('stop').attr('offset', '0%').attr('stop-color', '#14b8a6');
    titleAccent.append('stop').attr('offset', '100%').attr('stop-color', '#8b5cf6');

    svg.append('text')
      .attr('x', margin.left + 14)
      .attr('y', 30)
      .attr('text-anchor', 'start')
      .attr('fill', titleColor)
      .attr('font-size', '17px')
      .attr('font-weight', '600')
      .attr('letter-spacing', '-0.02em')
      .attr('opacity', 0)
      .text(title || (viewMode === 'equity' ? 'Net Worth Allocation Flow' : 'Asset Allocation Flow'))
      .transition()
      .duration(800)
      .attr('opacity', 1);
  }, [effectiveRootLabel, gradientIdBase, height, labelColor, rootValue, stableAllocations, subLabelColor, title, titleColor, totalValue, viewMode]);

  return (
    <div className={`w-full overflow-hidden rounded-2xl ${isDark ? 'bg-gradient-to-b from-slate-900 to-slate-950' : ''}`}>
      <div className="relative w-full" style={{ height: `${height}px` }}>
        <svg ref={svgRef} className="h-full w-full" />

        {hoveredNode ? (
          <div className={`absolute right-4 top-16 z-10 rounded-xl p-5 shadow-2xl ${isDark ? 'border border-slate-700 bg-slate-800 text-slate-100' : 'border border-slate-200 bg-white text-slate-800'}`}>
            <div className="mb-2 text-lg font-bold" style={{ color: hoveredNode.color }}>
              {hoveredNode.name}
            </div>
            <div className={`text-3xl font-bold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              ${hoveredNode.value.toLocaleString()}
            </div>
            <div className={`mt-2 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {((hoveredNode.value / rootValue) * 100).toFixed(2)}% of portfolio
            </div>
          </div>
        ) : null}

        {hoveredLink ? (
          <div className={`absolute right-4 top-16 z-10 rounded-xl p-5 shadow-2xl ${isDark ? 'border border-slate-700 bg-slate-800 text-slate-100' : 'border border-slate-200 bg-white text-slate-800'}`}>
            <div className={`mb-2 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Flow</div>
            <div className={`mb-1 font-semibold ${isDark ? 'text-white' : 'text-slate-900'}`}>
              {hoveredLink.source.name} → {hoveredLink.target.name}
            </div>
            <div className="text-2xl font-bold" style={{ color: hoveredLink.target.color }}>
              ${hoveredLink.value.toLocaleString()}
            </div>
            <div className={`mt-1 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {((hoveredLink.value / rootValue) * 100).toFixed(2)}% of total
            </div>
          </div>
        ) : null}

        <div className={`absolute bottom-3 left-3 z-10 rounded-xl p-3 shadow-lg ${isDark ? 'border border-slate-700/80 bg-slate-800/90 text-slate-100' : 'border border-slate-200 bg-white text-slate-800'}`}>
          <div className={`mb-2 text-[10px] font-semibold uppercase tracking-wide ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>Asset classes</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            {stableAllocations.filter((allocation) => allocation.value > 0).map((allocation) => (
              <div key={allocation.label} className="flex items-center gap-1.5">
                <div className="h-2.5 w-[3px] rounded-full" style={{ backgroundColor: allocation.color }} />
                <span className={isDark ? 'text-slate-300' : 'text-slate-700'}>{allocation.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}