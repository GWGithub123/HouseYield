export type IncomeProjectionsTabId = 'income' | 'dividend' | 'retirement';

export type IncomeProjectionSurfaceSize = 'full' | 'wide' | 'half' | 'third';
export type IncomeProjectionSurfaceHeight = 'compact' | 'standard' | 'tall' | 'hero';

export type IncomeProjectionAssetDefinition = {
  id: string;
  tab: IncomeProjectionsTabId;
  title: string;
  keywords: string[];
  defaultSize: IncomeProjectionSurfaceSize;
  defaultHeight: IncomeProjectionSurfaceHeight;
  cardClass: string;
  minHeight: number;
};

const standardPanel = {
  defaultSize: 'wide',
  defaultHeight: 'standard',
  cardClass: 'min-h-[240px] xl:min-h-[280px]',
  minHeight: 260,
} as const;

const compactWidePanel = {
  defaultSize: 'wide',
  defaultHeight: 'compact',
  cardClass: 'min-h-[180px] xl:min-h-[220px]',
  minHeight: 210,
} as const;

const tallPanel = {
  defaultSize: 'half',
  defaultHeight: 'tall',
  cardClass: 'min-h-[420px] xl:min-h-[520px]',
  minHeight: 460,
} as const;

const wideHeroPanel = {
  defaultSize: 'wide',
  defaultHeight: 'hero',
  cardClass: 'min-h-[720px] xl:min-h-[920px]',
  minHeight: 820,
} as const;

const fullHeroPanel = {
  defaultSize: 'full',
  defaultHeight: 'hero',
  cardClass: 'min-h-[1120px] xl:min-h-[1480px]',
  minHeight: 1340,
} as const;

export const INCOME_PROJECTION_DASHBOARD_ASSETS = [
  {
    id: 'income-projections-filters',
    tab: 'income',
    title: 'Income Filters',
    keywords: ['income filters', 'income source filter', 'rental basis filter', 'income controls'],
    ...standardPanel,
  },
  {
    id: 'income-projections-timeline',
    tab: 'income',
    title: 'Investment Income Timeline',
    keywords: ['investment income timeline', 'income timeline', 'projected income', 'income history', 'income projections chart', 'dividend calendar', 'upcoming payouts'],
    ...fullHeroPanel,
  },
  {
    id: 'income-projections-income-mix',
    tab: 'income',
    title: 'Income Mix',
    keywords: ['income mix', 'income donut', 'income mix by source', 'income mix sidecard'],
    defaultSize: 'third',
    defaultHeight: 'tall',
    cardClass: 'min-h-[520px] xl:min-h-[620px]',
    minHeight: 620,
  },
  {
    id: 'income-projections-dividend-income-by-stock',
    tab: 'dividend',
    title: 'Dividend Income by Stock',
    keywords: ['dividend income by stock', 'stock dividend income', 'dividend holdings', 'stock income table'],
    ...wideHeroPanel,
  },
  {
    id: 'income-projections-real-estate-holdings',
    tab: 'income',
    title: 'Real Estate Income Holdings',
    keywords: ['real estate holdings', 'rental income holdings', 'property income holdings'],
    ...tallPanel,
  },
  {
    id: 'income-projections-bond-holdings',
    tab: 'income',
    title: 'Bond Income Holdings',
    keywords: ['bond holdings', 'bond income', 'fixed income holdings'],
    defaultSize: 'half',
    defaultHeight: 'standard',
    cardClass: 'min-h-[280px] xl:min-h-[340px]',
    minHeight: 340,
  },
  {
    id: 'income-projections-retirement-settings',
    tab: 'retirement',
    title: 'Retirement Settings',
    keywords: ['retirement settings', 'financial independence settings', 'retirement assumptions', 'retirement controls'],
    defaultSize: 'full',
    defaultHeight: 'hero',
    cardClass: 'min-h-[760px] xl:min-h-[960px]',
    minHeight: 900,
  },
  {
    id: 'income-projections-retirement-scenario-controls',
    tab: 'retirement',
    title: 'Retirement Scenario Controls',
    keywords: ['retirement scenarios', 'scenario controls', 'retirement scenario selector', 'retirement control bar'],
    ...compactWidePanel,
  },
  {
    id: 'income-projections-retirement-ai-planner',
    tab: 'retirement',
    title: 'AI Financial Planner',
    keywords: ['ai financial planner', 'retirement ai planner', 'planner chat', 'retirement planning chat'],
    defaultSize: 'wide',
    defaultHeight: 'hero',
    cardClass: 'min-h-[560px] xl:min-h-[700px]',
    minHeight: 640,
  },
  {
    id: 'income-projections-expense-breakdown',
    tab: 'retirement',
    title: 'Expense Breakdown',
    keywords: ['expense breakdown', 'expense donut', 'retirement expenses'],
    defaultSize: 'third',
    defaultHeight: 'hero',
    cardClass: 'min-h-[560px] xl:min-h-[680px]',
    minHeight: 620,
  },
  {
    id: 'income-projections-fi-projection',
    tab: 'retirement',
    title: 'Financial Independence Projection',
    keywords: ['financial independence projection', 'fi projection', 'retirement projection', 'income vs expenses retirement'],
    defaultSize: 'wide',
    defaultHeight: 'hero',
    cardClass: 'min-h-[900px] xl:min-h-[1120px]',
    minHeight: 1080,
  },
] as const satisfies readonly IncomeProjectionAssetDefinition[];

export type IncomeProjectionAssetId = typeof INCOME_PROJECTION_DASHBOARD_ASSETS[number]['id'];

export const INCOME_PROJECTION_ASSET_METADATA = Object.fromEntries(
  INCOME_PROJECTION_DASHBOARD_ASSETS.map((asset) => [asset.id, asset]),
) as Record<IncomeProjectionAssetId, (typeof INCOME_PROJECTION_DASHBOARD_ASSETS)[number]>;

export function isIncomeProjectionAssetId(value: unknown): value is IncomeProjectionAssetId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INCOME_PROJECTION_ASSET_METADATA, value);
}

export function inferIncomeProjectionTabFromAsset(assetId: IncomeProjectionAssetId): IncomeProjectionsTabId {
  return INCOME_PROJECTION_ASSET_METADATA[assetId].tab;
}