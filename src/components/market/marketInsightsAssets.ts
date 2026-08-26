export type MarketInsightsTabId = 'overview' | 'economy' | 'fed';

export type MarketInsightsSurfaceSize = 'wide' | 'half' | 'third';
export type MarketInsightsSurfaceHeight = 'compact' | 'standard' | 'tall' | 'hero';

export type MarketInsightsAssetDefinition = {
  id: string;
  tab: MarketInsightsTabId;
  title: string;
  keywords: string[];
  defaultSize: MarketInsightsSurfaceSize;
  defaultHeight: MarketInsightsSurfaceHeight;
  cardClass: string;
  minHeight: number;
  fedFocusSection?:
    | 'executive-update'
    | 'upcoming-fomc-meeting'
    | 'policy-readout'
    | 'economic-outlook'
    | 'interest-rate-outlook'
    | 'housing-market-impact';
};

const compactMetric = {
  defaultSize: 'third',
  defaultHeight: 'compact',
  cardClass: 'min-h-[160px] xl:min-h-[180px]',
  minHeight: 180,
} as const;

const standardMetric = {
  defaultSize: 'third',
  defaultHeight: 'standard',
  cardClass: 'min-h-[220px] xl:min-h-[260px]',
  minHeight: 240,
} as const;

const chartSurface = {
  defaultSize: 'half',
  defaultHeight: 'hero',
  cardClass: 'min-h-[420px] xl:min-h-[520px]',
  minHeight: 520,
} as const;

const wideSection = {
  defaultSize: 'wide',
  defaultHeight: 'hero',
  cardClass: 'min-h-[320px] xl:min-h-[420px]',
  minHeight: 360,
} as const;

const overviewAssets = [
  {
    id: 'overview-metric-median-home-price',
    tab: 'overview',
    title: 'Market Overview Median Home Price',
    keywords: ['median home price', 'market overview price', 'home price metric'],
    ...compactMetric,
  },
  {
    id: 'overview-metric-inventory-months',
    tab: 'overview',
    title: 'Market Overview Inventory Months',
    keywords: ['inventory months', 'months supply metric', 'inventory metric'],
    ...compactMetric,
  },
  {
    id: 'overview-metric-days-on-market',
    tab: 'overview',
    title: 'Market Overview Days on Market',
    keywords: ['days on market', 'dom metric', 'market overview dom'],
    ...compactMetric,
  },
  {
    id: 'overview-metric-30-year-mortgage',
    tab: 'overview',
    title: 'Market Overview 30-Year Mortgage',
    keywords: ['30 year mortgage metric', 'mortgage rate metric', 'market overview mortgage'],
    ...compactMetric,
  },
  {
    id: 'overview-signal-supply-pressure',
    tab: 'overview',
    title: 'Market Signal Supply Pressure',
    keywords: ['supply pressure signal', 'market signal supply', 'inventory signal'],
    ...standardMetric,
  },
  {
    id: 'overview-signal-rate-environment',
    tab: 'overview',
    title: 'Market Signal Rate Environment',
    keywords: ['rate environment signal', 'market signal rates', 'mortgage environment signal'],
    ...standardMetric,
  },
  {
    id: 'overview-signal-price-momentum',
    tab: 'overview',
    title: 'Market Signal Price Momentum',
    keywords: ['price momentum signal', 'market signal momentum', 'home price momentum'],
    ...standardMetric,
  },
  {
    id: 'overview-signal-credit-spread',
    tab: 'overview',
    title: 'Market Signal Credit Spread',
    keywords: ['credit spread signal', 'yield spread signal', 'mortgage spread signal'],
    ...standardMetric,
  },
  {
    id: 'overview-ai-market-outlook',
    tab: 'overview',
    title: 'AI Market Outlook',
    keywords: ['ai market outlook', 'market ai analysis', 'overview ai outlook'],
    ...wideSection,
  },
  {
    id: 'overview-financing-regime',
    tab: 'overview',
    title: 'Financing Regime Summary',
    keywords: ['financing regime', 'rates yields financing', 'financing summary'],
    ...wideSection,
  },
  {
    id: 'overview-financing-10-year-treasury',
    tab: 'overview',
    title: '10-Year Treasury Metric',
    keywords: ['10 year treasury metric', 'treasury metric', 'financing treasury card'],
    ...standardMetric,
  },
  {
    id: 'overview-financing-30-year-mortgage',
    tab: 'overview',
    title: '30-Year Mortgage Metric',
    keywords: ['30 year mortgage metric', 'mortgage financing card', 'financing mortgage metric'],
    ...standardMetric,
  },
  {
    id: 'overview-financing-10y-2y-spread',
    tab: 'overview',
    title: '10Y-2Y Spread Metric',
    keywords: ['10y 2y spread metric', 'yield spread metric', 'curve spread card'],
    ...standardMetric,
  },
  {
    id: 'overview-chart-10-year-treasury-history',
    tab: 'overview',
    title: '10-Year Treasury History',
    keywords: ['10 year treasury history', 'treasury history chart', 'overview treasury chart'],
    ...chartSurface,
  },
  {
    id: 'overview-chart-30-year-mortgage-history',
    tab: 'overview',
    title: '30-Year Mortgage History',
    keywords: ['30 year mortgage history', 'mortgage history chart', 'overview mortgage chart'],
    ...chartSurface,
  },
  {
    id: 'overview-chart-10y-2y-spread-history',
    tab: 'overview',
    title: '10Y-2Y Spread History',
    keywords: ['10y 2y spread history', 'yield spread history', 'curve history chart'],
    ...chartSurface,
  },
  {
    id: 'overview-chart-median-home-price-trend',
    tab: 'overview',
    title: 'Median Home Price Trend',
    keywords: ['median home price trend', 'home price trend chart', 'overview home price chart'],
    ...chartSurface,
  },
  {
    id: 'overview-chart-mortgage-rate-trend',
    tab: 'overview',
    title: 'Mortgage Rate Trend',
    keywords: ['mortgage rate trend', 'market mortgage trend', 'overview mortgage trend'],
    ...chartSurface,
  },
  {
    id: 'overview-chart-months-supply-of-inventory',
    tab: 'overview',
    title: 'Months Supply of Inventory',
    keywords: ['months supply inventory', 'inventory trend chart', 'supply chart'],
    ...chartSurface,
  },
  {
    id: 'overview-segment-single-family-price-index',
    tab: 'overview',
    title: 'Single Family Price Index',
    keywords: ['single family price index', 'single family chart', 'segment positioning single family'],
    ...chartSurface,
  },
  {
    id: 'overview-segment-property-type-trends',
    tab: 'overview',
    title: 'Property Type Trends',
    keywords: ['property type trends', 'market trends by property type', 'segment positioning property types'],
    defaultSize: 'half',
    defaultHeight: 'standard',
    cardClass: 'min-h-[320px] xl:min-h-[380px]',
    minHeight: 380,
  },
  {
    id: 'overview-segment-top-metro-markets',
    tab: 'overview',
    title: 'Top Metro Markets',
    keywords: ['top metro markets', 'metro markets table', 'segment positioning metros'],
    defaultSize: 'half',
    defaultHeight: 'standard',
    cardClass: 'min-h-[320px] xl:min-h-[380px]',
    minHeight: 380,
  },
] as const satisfies readonly MarketInsightsAssetDefinition[];

const economyAssets = [
  {
    id: 'economy-metric-initial-jobless-claims',
    tab: 'economy',
    title: 'Initial Jobless Claims',
    keywords: ['initial jobless claims', 'jobless claims metric', 'labor demand metric'],
    ...standardMetric,
  },
  {
    id: 'economy-metric-consumer-sentiment',
    tab: 'economy',
    title: 'Consumer Sentiment',
    keywords: ['consumer sentiment', 'consumer pulse metric', 'sentiment metric'],
    ...standardMetric,
  },
  {
    id: 'economy-metric-homeownership-rate',
    tab: 'economy',
    title: 'Homeownership Rate',
    keywords: ['homeownership rate', 'household mix metric', 'ownership rate metric'],
    ...standardMetric,
  },
  {
    id: 'economy-metric-core-pce-price-index',
    tab: 'economy',
    title: 'Core PCE Price Index',
    keywords: ['core pce', 'pce price index', 'inflation anchor metric'],
    ...standardMetric,
  },
  {
    id: 'economy-metric-10y-breakeven-inflation',
    tab: 'economy',
    title: '10Y Breakeven Inflation',
    keywords: ['10y breakeven inflation', 'breakeven inflation metric', 'market pricing inflation'],
    ...standardMetric,
  },
  {
    id: 'economy-metric-15-year-mortgage-rate',
    tab: 'economy',
    title: '15-Year Mortgage Rate',
    keywords: ['15 year mortgage rate', 'short mortgage rate metric', 'financing cost metric'],
    ...standardMetric,
  },
  {
    id: 'economy-metric-new-home-sales',
    tab: 'economy',
    title: 'New Home Sales',
    keywords: ['new home sales', 'housing supply sales metric', 'new supply metric'],
    ...standardMetric,
  },
  {
    id: 'economy-metric-rental-vacancy-rate',
    tab: 'economy',
    title: 'Rental Vacancy Rate',
    keywords: ['rental vacancy rate', 'rental tightness metric', 'vacancy metric'],
    ...standardMetric,
  },
  {
    id: 'economy-metric-construction-cost-index',
    tab: 'economy',
    title: 'Construction Cost Index',
    keywords: ['construction cost index', 'construction ppi metric', 'build cost metric'],
    ...standardMetric,
  },
  {
    id: 'economy-investor-chart-mortgage-vs-median-price',
    tab: 'economy',
    title: '30Y Mortgage vs Median Price',
    keywords: ['mortgage vs median price', 'investor ratio mortgage price', 'pricing sensitivity scatter'],
    ...chartSurface,
  },
  {
    id: 'economy-investor-chart-housing-starts-vs-permits',
    tab: 'economy',
    title: 'Housing Starts vs Permits',
    keywords: ['housing starts vs permits', 'supply pipeline scatter', 'starts permits chart'],
    ...chartSurface,
  },
  {
    id: 'economy-investor-chart-case-shiller-vs-rent-cpi',
    tab: 'economy',
    title: 'Case-Shiller vs Rent CPI',
    keywords: ['case shiller vs rent cpi', 'price vs rent scatter', 'price rent slope'],
    ...chartSurface,
  },
  {
    id: 'economy-investor-chart-rent-growth-vs-10y-treasury',
    tab: 'economy',
    title: 'Rent Growth vs 10Y Treasury',
    keywords: ['rent growth vs treasury', 'cap rate spread scatter', 'income premium chart'],
    ...chartSurface,
  },
  {
    id: 'economy-investor-chart-rental-vacancy-vs-median-price',
    tab: 'economy',
    title: 'Rental Vacancy vs Median Price',
    keywords: ['rental vacancy vs median price', 'vacancy price scatter', 'correction risk chart'],
    ...chartSurface,
  },
  {
    id: 'economy-investor-chart-beveridge-curve',
    tab: 'economy',
    title: 'Beveridge Curve',
    keywords: ['beveridge curve', 'labor tightness curve', 'vacancy unemployment chart'],
    ...chartSurface,
  },
  {
    id: 'economy-trend-chart-initial-jobless-claims',
    tab: 'economy',
    title: 'Initial Jobless Claims Trend',
    keywords: ['jobless claims trend', 'claims history chart', 'economy trend claims'],
    ...chartSurface,
  },
  {
    id: 'economy-trend-chart-consumer-sentiment',
    tab: 'economy',
    title: 'Consumer Sentiment Trend',
    keywords: ['consumer sentiment trend', 'sentiment history chart', 'economy trend sentiment'],
    ...chartSurface,
  },
  {
    id: 'economy-trend-chart-core-pce-index',
    tab: 'economy',
    title: 'Core PCE Trend',
    keywords: ['core pce trend', 'pce history chart', 'economy trend pce'],
    ...chartSurface,
  },
  {
    id: 'economy-trend-chart-10y-breakeven-inflation',
    tab: 'economy',
    title: '10Y Breakeven Inflation Trend',
    keywords: ['breakeven inflation trend', '10y breakeven chart', 'economy trend breakeven'],
    ...chartSurface,
  },
  {
    id: 'economy-trend-chart-new-home-sales',
    tab: 'economy',
    title: 'New Home Sales Trend',
    keywords: ['new home sales trend', 'sales history chart', 'economy trend new home sales'],
    ...chartSurface,
  },
  {
    id: 'economy-trend-chart-construction-cost-index',
    tab: 'economy',
    title: 'Construction Cost Index Trend',
    keywords: ['construction cost trend', 'construction ppi chart', 'economy trend construction cost'],
    ...chartSurface,
  },
] as const satisfies readonly MarketInsightsAssetDefinition[];

const fedAssets = [
  {
    id: 'fed-summary-executive-update',
    tab: 'fed',
    title: 'Federal Reserve Executive Update',
    keywords: ['federal reserve update', 'fed executive summary', 'fed headline'],
    defaultSize: 'wide',
    defaultHeight: 'hero',
    cardClass: 'min-h-[520px] xl:min-h-[620px]',
    minHeight: 620,
    fedFocusSection: 'executive-update',
  },
  {
    id: 'fed-summary-upcoming-fomc-meeting',
    tab: 'fed',
    title: 'Upcoming FOMC Meeting',
    keywords: ['upcoming fomc meeting', 'fomc countdown', 'fed schedule'],
    defaultSize: 'wide',
    defaultHeight: 'tall',
    cardClass: 'min-h-[420px] xl:min-h-[520px]',
    minHeight: 520,
    fedFocusSection: 'upcoming-fomc-meeting',
  },
  {
    id: 'fed-summary-policy-readout',
    tab: 'fed',
    title: 'Policy Readout',
    keywords: ['policy readout', 'fomc statement summary', 'ai source docs'],
    defaultSize: 'wide',
    defaultHeight: 'hero',
    cardClass: 'min-h-[560px] xl:min-h-[720px]',
    minHeight: 720,
    fedFocusSection: 'policy-readout',
  },
  {
    id: 'fed-summary-economic-outlook',
    tab: 'fed',
    title: 'Fed Economic Outlook',
    keywords: ['fed economic outlook', 'economic outlook cards', 'fed outlook'],
    defaultSize: 'wide',
    defaultHeight: 'tall',
    cardClass: 'min-h-[360px] xl:min-h-[440px]',
    minHeight: 440,
    fedFocusSection: 'economic-outlook',
  },
  {
    id: 'fed-summary-interest-rate-outlook',
    tab: 'fed',
    title: 'Fed Interest Rate Outlook',
    keywords: ['interest rate outlook', 'fed stance', 'next meeting expectation'],
    defaultSize: 'half',
    defaultHeight: 'tall',
    cardClass: 'min-h-[320px] xl:min-h-[380px]',
    minHeight: 380,
    fedFocusSection: 'interest-rate-outlook',
  },
  {
    id: 'fed-summary-housing-market-impact',
    tab: 'fed',
    title: 'Fed Housing Market Impact',
    keywords: ['housing market impact', 'fed housing outlook', 'housing activity outlook'],
    defaultSize: 'half',
    defaultHeight: 'tall',
    cardClass: 'min-h-[320px] xl:min-h-[380px]',
    minHeight: 380,
    fedFocusSection: 'housing-market-impact',
  },
  {
    id: 'fed-prediction-fed-rate-cut',
    tab: 'fed',
    title: 'Prediction Fed Rate Cut',
    keywords: ['fed rate cut prediction', 'polymarket fed rate cut', 'fed prediction card'],
    ...standardMetric,
  },
  {
    id: 'fed-prediction-mortgage-rate',
    tab: 'fed',
    title: 'Prediction Mortgage Rate',
    keywords: ['mortgage rate prediction', 'polymarket mortgage rate', 'mortgage prediction card'],
    ...standardMetric,
  },
  {
    id: 'fed-prediction-housing-market',
    tab: 'fed',
    title: 'Prediction Housing Market',
    keywords: ['housing market prediction', 'polymarket housing market', 'housing prediction card'],
    ...standardMetric,
  },
  {
    id: 'fed-prediction-gdp-growth',
    tab: 'fed',
    title: 'Prediction GDP Growth',
    keywords: ['gdp growth prediction', 'polymarket gdp growth', 'gdp prediction card'],
    ...standardMetric,
  },
  {
    id: 'fed-prediction-recession',
    tab: 'fed',
    title: 'Prediction Recession Odds',
    keywords: ['recession prediction', 'polymarket recession', 'recession odds card'],
    ...standardMetric,
  },
  {
    id: 'fed-prediction-inflation',
    tab: 'fed',
    title: 'Prediction Inflation',
    keywords: ['inflation prediction', 'polymarket inflation', 'inflation odds card'],
    ...standardMetric,
  },
  {
    id: 'fed-prediction-unemployment',
    tab: 'fed',
    title: 'Prediction Unemployment',
    keywords: ['unemployment prediction', 'polymarket unemployment', 'unemployment odds card'],
    ...standardMetric,
  },
] as const satisfies readonly MarketInsightsAssetDefinition[];

export const MARKET_INSIGHTS_DASHBOARD_ASSETS = [
  ...overviewAssets,
  ...economyAssets,
  ...fedAssets,
] as const satisfies readonly MarketInsightsAssetDefinition[];

export type MarketInsightsAssetId = typeof MARKET_INSIGHTS_DASHBOARD_ASSETS[number]['id'];

export const MARKET_INSIGHTS_ASSET_METADATA = Object.fromEntries(
  MARKET_INSIGHTS_DASHBOARD_ASSETS.map((asset) => [asset.id, asset]),
) as Record<MarketInsightsAssetId, (typeof MARKET_INSIGHTS_DASHBOARD_ASSETS)[number]>;

export function isMarketInsightsAssetId(value: string | null | undefined): value is MarketInsightsAssetId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MARKET_INSIGHTS_ASSET_METADATA, value);
}

export function inferMarketInsightsTabFromAsset(value: string | null | undefined): MarketInsightsTabId | null {
  if (!isMarketInsightsAssetId(value)) return null;
  return MARKET_INSIGHTS_ASSET_METADATA[value].tab;
}