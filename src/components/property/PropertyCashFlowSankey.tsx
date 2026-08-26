import React, { useMemo } from 'react';
import ComprehensiveAssetSankey, { type ComprehensiveAssetSankeyAllocation } from '../ComprehensiveAssetSankey';
import type { PropertyPortfolioAllocationItem } from '../../services/canonicalPortfolioService';

type PropertyCashFlowSankeyProps = {
  allocations: PropertyPortfolioAllocationItem[];
};

export default function PropertyCashFlowSankey({ allocations }: PropertyCashFlowSankeyProps) {
  const sankeyAllocations = useMemo<ComprehensiveAssetSankeyAllocation[]>(() => {
    return allocations
      .map((item) => {
        const annualIncome = Math.max(item.monthlyIncome * 12, 0);
        const annualOperatingExpenses = Math.max(item.monthlyExpenses * 12, 0);
        const annualDebtService = Math.max(item.monthlyMortgage * 12, 0);
        const annualNetCashFlow = item.monthlyCashFlow * 12;
        const assetList = [
          { name: `${item.label} operating expenses`, value: annualOperatingExpenses },
          { name: `${item.label} debt service`, value: annualDebtService },
          { name: annualNetCashFlow >= 0 ? `${item.label} net cash flow` : `${item.label} cash deficit`, value: Math.abs(annualNetCashFlow) },
        ].filter((entry) => entry.value > 0);

        return {
          label: item.label,
          value: annualIncome,
          percentage: 0,
          color: item.color,
          assetList,
        };
      })
      .filter((item) => item.value > 0);
  }, [allocations]);

  const totalValue = sankeyAllocations.reduce((sum, item) => sum + item.value, 0);
  const hydratedAllocations = useMemo(
    () => sankeyAllocations.map((item) => ({
      ...item,
      percentage: totalValue > 0 ? (item.value / totalValue) * 100 : 0,
    })),
    [sankeyAllocations, totalValue],
  );

  return (
    <ComprehensiveAssetSankey
      allocations={hydratedAllocations}
      totalValue={totalValue}
      viewMode="assets"
      rootLabel="Gross Rental Income"
      title="Property Cash Flow"
      theme="light"
      height={360}
    />
  );
}
