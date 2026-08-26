/**
 * Market Analysis Routes
 * Streaming Claude SSE endpoints for macro, regional, and hyper-local real estate analysis.
 * Non-streaming endpoints for ATTOM sales trend and rental comp data.
 */

import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { fetchZipSalesTrend, calculateZipAppreciation } from '../attom.js';
import { getRentalListingComparables } from '../rentcast.js';
import { getCachedFredData, setCachedFredData } from '../fred-cache.js';

const router = Router();
const anthropic = new Anthropic({
  apiKey: process.env.Claude_API_Key || process.env.ANTHROPIC_API_KEY,
});
const POLYGON_API_KEY = process.env.POLYGON_API_KEY || process.env.VITE_POLYGON_API_KEY || '';
const EVENT_REGISTRY_API_KEY = process.env.EVENT_REGISTRY_API_KEY || process.env.Event_Registry_API_Key || '';
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || process.env.Finnhub_API_Key || '';

function startSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function decodeHtmlEntities(text = '') {
  return text
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRssItems(xml = '') {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const chunk = match[1];
    const title = decodeHtmlEntities(chunk.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '');
    const link = decodeHtmlEntities(chunk.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '');
    const pubDate = decodeHtmlEntities(chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || '');
    if (!title || !link) continue;
    items.push({ title, link, pubDate });
  }
  return items;
}

function getMetricValue(entry) {
  if (entry && typeof entry === 'object' && 'value' in entry) return entry.value;
  return entry;
}

function getMetricField(entry, field) {
  return entry && typeof entry === 'object' ? entry[field] : undefined;
}

function parseNumericMetric(entry) {
  const rawValue = getMetricValue(entry);
  if (rawValue === null || rawValue === undefined) return null;
  const numericValue = Number.parseFloat(String(rawValue).replace(/,/g, ''));
  return Number.isFinite(numericValue) ? numericValue : null;
}

function formatHistoryWindow(label, history, count = 6) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const sample = history.slice(-count).map((point) => `${point.date}: ${point.value}`);
  return `- ${label}: ${sample.join(' | ')}`;
}

function dedupeNewsItems(items, limit = 6) {
  const deduped = [];
  const seenTitles = new Set();

  for (const item of items) {
    if (!item?.title) continue;
    const normalizedTitle = String(item.title).trim().toLowerCase();
    if (!normalizedTitle || seenTitles.has(normalizedTitle)) continue;
    seenTitles.add(normalizedTitle);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

function buildMacroScenarioSignals(macroData) {
  const signals = [];

  const joblessClaimsValue = parseNumericMetric(macroData?.joblessClaims);
  const joblessClaimsYoy = Number.parseFloat(String(getMetricField(macroData?.joblessClaims, 'yoy') ?? 'NaN'));
  if (joblessClaimsValue !== null && Number.isFinite(joblessClaimsYoy) && joblessClaimsYoy >= 5) {
    signals.push(`Labor softening signal: initial jobless claims are ${Math.round(joblessClaimsValue).toLocaleString()} with ${joblessClaimsYoy >= 0 ? '+' : ''}${joblessClaimsYoy.toFixed(1)}% YoY change, which may support additional Fed easing if the trend persists.`);
  }

  const jobOpeningsValue = parseNumericMetric(macroData?.jobOpenings);
  const jobOpeningsYoy = Number.parseFloat(String(getMetricField(macroData?.jobOpenings, 'yoy') ?? 'NaN'));
  if (jobOpeningsValue !== null && Number.isFinite(jobOpeningsYoy) && jobOpeningsYoy <= -5) {
    signals.push(`Demand-for-labor cooling signal: job openings are ${Math.round(jobOpeningsValue).toLocaleString()} with ${jobOpeningsYoy.toFixed(1)}% YoY change, which may indicate a slower economy and earlier Fed relief.`);
  }

  const oilPriceValue = parseNumericMetric(macroData?.oilPrice);
  const oilPriceYoy = Number.parseFloat(String(getMetricField(macroData?.oilPrice, 'yoy') ?? 'NaN'));
  if (oilPriceValue !== null && Number.isFinite(oilPriceYoy) && oilPriceYoy >= 10) {
    signals.push(`Energy inflation signal: WTI crude is near $${oilPriceValue.toFixed(1)} with ${oilPriceYoy >= 0 ? '+' : ''}${oilPriceYoy.toFixed(1)}% YoY change, which may keep CPI and Fed policy firmer for longer.`);
  }

  const corePceMom = Number.parseFloat(String(getMetricField(macroData?.corePCE, 'mom') ?? 'NaN'));
  const corePceYoy = Number.parseFloat(String(getMetricField(macroData?.corePCE, 'yoy') ?? 'NaN'));
  if (Number.isFinite(corePceMom) && Number.isFinite(corePceYoy) && (corePceMom >= 0.3 || corePceYoy >= 3)) {
    signals.push(`Sticky inflation signal: Core PCE is ${getMetricValue(macroData?.corePCE)} with ${corePceMom >= 0 ? '+' : ''}${corePceMom.toFixed(1)}% sequential change and ${corePceYoy >= 0 ? '+' : ''}${corePceYoy.toFixed(1)}% YoY change.`);
  }

  return signals.slice(0, 4);
}

function buildNewsTransmissionSignals({ macroHeadlines = [], polygonNews = [], finnhubNews = [], eventRegistryNews = [], macroData, treasuryYields, housingData }) {
  const signals = [];
  const combinedHeadlines = [...macroHeadlines, ...polygonNews, ...finnhubNews, ...eventRegistryNews]
    .map((item) => `${item.title || ''} ${item.summary || ''} ${item.description || ''} ${item.topic || ''} ${item.publisher || ''} ${item.source || ''}`.toLowerCase())
    .join(' ');

  const oilPrice = parseNumericMetric(macroData?.oilPrice);
  const oilPriceYoy = Number.parseFloat(String(getMetricField(macroData?.oilPrice, 'yoy') ?? 'NaN'));
  const corePceYoy = Number.parseFloat(String(getMetricField(macroData?.corePCE, 'yoy') ?? 'NaN'));
  const breakeven10Y = parseNumericMetric(macroData?.breakeven10Y);
  const t10y = treasuryYields?.t10y != null ? Number(treasuryYields.t10y) : null;
  const mortgageRate = housingData?.mortgageRate != null ? Number(housingData.mortgageRate) : null;
  const joblessClaims = parseNumericMetric(macroData?.joblessClaims);
  const joblessClaimsYoy = Number.parseFloat(String(getMetricField(macroData?.joblessClaims, 'yoy') ?? 'NaN'));
  const jobOpenings = parseNumericMetric(macroData?.jobOpenings);
  const jobOpeningsYoy = Number.parseFloat(String(getMetricField(macroData?.jobOpenings, 'yoy') ?? 'NaN'));

  const hasHormuzRisk = /(hormuz|iran|shipping lane|shipping|middle east|israel|war|tankers?)/.test(combinedHeadlines);
  const hasOilShock = /(oil|crude|energy|gasoline|supply disruption|hurricane season)/.test(combinedHeadlines);
  const hasLaborSofteningHeadline = /(jobless claims|unemployment|jobs report|payroll|jolts|job openings)/.test(combinedHeadlines);
  const hasInflationHeadline = /(inflation|cpi|pce|fed|rates|yield)/.test(combinedHeadlines);
  const hasHousingHeadline = /(housing|mortgage|homebuilder|reit|real estate|inventory|home prices)/.test(combinedHeadlines);

  if (hasHormuzRisk || hasOilShock) {
    signals.push(
      `Geopolitical energy transmission: current Iran/Hormuz or oil-supply headlines imply potential crude and shipping-cost pressure${oilPrice !== null ? ` with WTI already near $${oilPrice.toFixed(1)}` : ''}${Number.isFinite(oilPriceYoy) ? ` and ${oilPriceYoy >= 0 ? '+' : ''}${oilPriceYoy.toFixed(1)}% YoY` : ''}; if sustained, that may feed broader CPI expectations${breakeven10Y !== null ? ` and keep 10Y breakevens around ${breakeven10Y.toFixed(2)}%` : ''}, limiting relief in ${t10y !== null ? `${t10y.toFixed(2)}% 10Y Treasuries` : 'Treasury yields'} and ${mortgageRate !== null ? `${mortgageRate.toFixed(2)}% mortgage rates` : 'mortgage rates'}.`
    );
  }

  if (hasInflationHeadline && Number.isFinite(corePceYoy)) {
    signals.push(
      `Inflation persistence transmission: current inflation headlines should be read against Core PCE still running at ${corePceYoy.toFixed(1)}% YoY, which means any energy or freight shock may delay Fed easing rather than just create a short-lived headline move.`
    );
  }

  if (hasLaborSofteningHeadline && (joblessClaims !== null || jobOpenings !== null)) {
    signals.push(
      `Labor-demand transmission: labor headlines matter because jobless claims are ${joblessClaims !== null ? Math.round(joblessClaims).toLocaleString() : 'unavailable'}${Number.isFinite(joblessClaimsYoy) ? ` (${joblessClaimsYoy >= 0 ? '+' : ''}${joblessClaimsYoy.toFixed(1)}% YoY)` : ''} and job openings are ${jobOpenings !== null ? Math.round(jobOpenings).toLocaleString() : 'unavailable'}${Number.isFinite(jobOpeningsYoy) ? ` (${jobOpeningsYoy >= 0 ? '+' : ''}${jobOpeningsYoy.toFixed(1)}% YoY)` : ''}; softer labor demand may offset some inflation pressure, but it also weakens housing demand and tenant formation.`
    );
  }

  if (hasHousingHeadline && mortgageRate !== null) {
    signals.push(
      `Housing transmission: current housing and REIT headlines should be tied back to financing conditions, because ${mortgageRate.toFixed(2)}% mortgage rates and still-restrictive credit keep affordability tight, investor leverage less attractive, and inventory normalization more likely to pressure prices before demand fully recovers.`
    );
  }

  return signals.slice(0, 5);
}

async function fetchMacroHeadlineContext() {
  const headlineQueries = [
    { topic: 'Labor', query: 'US jobless claims Federal Reserve economy' },
    { topic: 'Unemployment', query: 'US unemployment rate jobs report Federal Reserve economy' },
    { topic: 'Jobs', query: 'JOLTS job openings Federal Reserve economy' },
    { topic: 'Inflation', query: 'core PCE inflation Federal Reserve CPI' },
    { topic: 'Housing', query: 'US housing market inventory mortgage rates home prices' },
    { topic: 'Energy', query: 'oil prices Middle East inflation Federal Reserve' },
    { topic: 'Geopolitics', query: 'geopolitical tensions shipping energy inflation Federal Reserve' },
    { topic: 'Hormuz', query: 'Strait of Hormuz shutdown Iran oil shipping inflation' },
    { topic: 'Middle East', query: 'Iran Israel conflict oil prices inflation shipping' },
  ];

  const responses = await Promise.allSettled(
    headlineQueries.map(async ({ topic, query }) => {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'HouseYield/1.0' },
      });
      if (!response.ok) throw new Error(`headline_fetch_failed:${topic}`);
      const xml = await response.text();
      const item = parseRssItems(xml)[0];
      if (!item) return null;
      return {
        topic,
        title: item.title,
        pubDate: item.pubDate,
      };
    })
  );

  const deduped = [];
  const seenTitles = new Set();
  for (const result of responses) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const normalizedTitle = result.value.title.toLowerCase();
    if (seenTitles.has(normalizedTitle)) continue;
    seenTitles.add(normalizedTitle);
    deduped.push(result.value);
  }

  return deduped.slice(0, 8);
}

async function fetchPolygonMarketNewsContext() {
  if (!POLYGON_API_KEY) return [];

  const newsTargets = [
    { topic: 'Rates', ticker: 'TLT' },
    { topic: 'Mortgages', ticker: 'MBB' },
    { topic: 'Housing', ticker: 'XHB' },
    { topic: 'Real Estate', ticker: 'VNQ' },
    { topic: 'Banks', ticker: 'KRE' },
    { topic: 'Oil', ticker: 'USO' },
    { topic: 'Energy', ticker: 'XLE' },
    { topic: 'Macro', ticker: 'SPY' },
  ];

  const responses = await Promise.allSettled(
    newsTargets.map(async ({ topic, ticker }) => {
      const url = `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(ticker)}&limit=3&order=desc&sort=published_utc&apiKey=${POLYGON_API_KEY}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'HouseYield/1.0' },
      });
      if (!response.ok) throw new Error(`polygon_news_failed:${ticker}`);
      const data = await response.json();
      const item = Array.isArray(data?.results) ? data.results[0] : null;
      if (!item?.title) return null;
      return {
        topic,
        ticker,
        title: item.title,
        publisher: item.publisher?.name || 'Polygon',
        publishedUtc: item.published_utc || null,
        description: item.description || '',
      };
    })
  );

  return dedupeNewsItems(
    responses
      .filter((result) => result.status === 'fulfilled' && result.value)
      .map((result) => result.value),
    6
  );
}

async function fetchFinnhubMarketNewsContext() {
  if (!FINNHUB_API_KEY) return [];

  const relevancePattern = /(fed|rates?|treasury|mortgage|housing|real estate|homebuilder|inflation|cpi|pce|jobs?|labor|payroll|unemployment|jobless|jolts|oil|crude|energy|iran|israel|hormuz|shipping|freight|yield)/i;
  const categories = ['general', 'forex'];

  const responses = await Promise.allSettled(
    categories.map(async (category) => {
      const url = `https://finnhub.io/api/v1/news?category=${encodeURIComponent(category)}&token=${FINNHUB_API_KEY}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'HouseYield/1.0' },
      });
      if (!response.ok) throw new Error(`finnhub_news_failed:${category}`);
      const data = await response.json();
      const items = Array.isArray(data) ? data : [];

      return items
        .filter((item) => item?.headline && relevancePattern.test(`${item.headline} ${item.summary || ''}`))
        .slice(0, 4)
        .map((item) => ({
          topic: category === 'forex' ? 'Macro Markets' : 'Macro',
          title: item.headline,
          source: item.source || 'Finnhub',
          summary: item.summary || '',
          publishedAt: item.datetime ? new Date(item.datetime * 1000).toISOString() : null,
          url: item.url || '',
        }));
    })
  );

  return dedupeNewsItems(
    responses
      .filter((result) => result.status === 'fulfilled' && Array.isArray(result.value))
      .flatMap((result) => result.value),
    6
  );
}

async function fetchEventRegistryNewsContext() {
  if (!EVENT_REGISTRY_API_KEY) return [];

  const today = new Date();
  const lookback = new Date(today);
  lookback.setDate(today.getDate() - 10);

  const queryGroups = [
    {
      topic: 'Geopolitics & Energy',
      keywords: ['Iran', 'Strait of Hormuz', 'oil', 'shipping', 'Middle East'],
    },
    {
      topic: 'Macro & Housing',
      keywords: ['Federal Reserve', 'mortgage rates', 'housing market', 'jobless claims', 'inflation'],
    },
  ];

  const responses = await Promise.allSettled(
    queryGroups.map(async ({ topic, keywords }) => {
      const params = new URLSearchParams({
        apiKey: EVENT_REGISTRY_API_KEY,
        resultType: 'articles',
        articlesCount: '4',
        articlesSortBy: 'date',
        articlesSortByAsc: 'false',
        dataType: 'news',
        lang: 'eng',
        keywordOper: 'or',
        dateStart: lookback.toISOString().slice(0, 10),
        dateEnd: today.toISOString().slice(0, 10),
        includeArticleTitle: 'true',
        includeArticleBasicInfo: 'true',
        includeArticleBody: 'false',
        includeSourceTitle: 'true',
        includeSourceDescription: 'false',
        includeArticleImage: 'false',
      });

      for (const keyword of keywords) params.append('keyword', keyword);

      const url = `https://eventregistry.org/api/v1/article/getArticles?${params.toString()}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'HouseYield/1.0' },
      });
      if (!response.ok) throw new Error(`event_registry_failed:${topic}`);
      const data = await response.json();
      const results = Array.isArray(data?.articles?.results) ? data.articles.results : [];

      return results.map((item) => ({
        topic,
        title: item.title,
        source: item.source?.title || item.source?.uri || 'Event Registry',
        summary: item.body ? String(item.body).slice(0, 240).trim() : '',
        publishedAt: item.dateTime || item.date || null,
        url: item.url || '',
      }));
    })
  );

  return dedupeNewsItems(
    responses
      .filter((result) => result.status === 'fulfilled' && Array.isArray(result.value))
      .flatMap((result) => result.value),
    6
  );
}

// POST /api/market/ai-analysis — macro market analysis
router.post('/market/ai-analysis', async (req, res) => {
  try {
    const { housingData, treasuryYields, macroData, predictions } = req.body;
    startSSE(res);

    const macroHeadlines = await fetchMacroHeadlineContext().catch(() => []);
    const polygonNews = await fetchPolygonMarketNewsContext().catch(() => []);
    const finnhubNews = await fetchFinnhubMarketNewsContext().catch(() => []);
    const eventRegistryNews = await fetchEventRegistryNewsContext().catch(() => []);
    const macroSignals = buildMacroScenarioSignals(macroData);
    const newsTransmissionSignals = buildNewsTransmissionSignals({
      macroHeadlines,
      polygonNews,
      finnhubNews,
      eventRegistryNews,
      macroData,
      treasuryYields,
      housingData,
    });

    res.write(`data: ${JSON.stringify({
      type: 'context',
      context: {
        macroHeadlines,
        polygonNews,
        finnhubNews,
        eventRegistryNews,
        macroSignals,
        newsTransmissionSignals,
      },
    })}\n\n`);

    const systemPrompt = `You are a senior macro economist and real estate investment analyst. Analyze the provided economic data and deliver a precise, data-grounded market outlook for real estate investors.

Structure your response in these EXACT sections using these headers:
## MARKET OVERVIEW
(2-3 sentence current state snapshot. Lead with the dominant regime: rate-driven contraction, inventory-led recovery, inflation plateau, etc. Include the mortgage rate, its spread vs. the 10Y Treasury, and one relevant current macro catalyst or headline. If there is a geopolitical or oil-related headline in the context, explicitly explain the transmission chain from that event into inflation expectations, Treasury yields, and mortgage rates.)

## 3-MONTH OUTLOOK
(Exactly 3 bullet points beginning with "-". Each bullet should be a broader overview sentence, not a fragment. Cover: 1) rates/Fed plus inflation, 2) labor-growth plus demand, 3) housing supply-prices plus investor cash flow/cap rates. Use conditional language such as may, could, or likely. Never use "will" for forecasts.)

## 3-MONTH DETAIL
(A fuller explanation for the 3-month view. Use 2 short paragraphs or 4 bullet points. Cite specific data points from the context, explain the causal chain, and reference at least one current headline or macro catalyst. When relevant, explicitly connect geopolitical or shipping headlines to oil, CPI/PCE, breakevens, Treasury yields, and mortgage rates.)

## 6-MONTH OUTLOOK
(Exactly 3 bullet points beginning with "-". Each bullet should be a broader overview sentence, not a fragment. Cover: 1) rates/Fed plus inflation, 2) labor-growth plus demand, 3) housing supply-prices plus investor cash flow/cap rates. Use conditional language such as may, could, or likely. Never use "will" for forecasts.)

## 6-MONTH DETAIL
(A fuller explanation for the 6-month view. Use 2 short paragraphs or 4 bullet points. Cite specific data points from the context, explain the causal chain, and reference at least one current headline or macro catalyst. When relevant, explicitly connect geopolitical or shipping headlines to oil, CPI/PCE, breakevens, Treasury yields, and mortgage rates.)

## 12-MONTH OUTLOOK
(Exactly 3 bullet points beginning with "-". Each bullet should be a broader overview sentence, not a fragment. Cover: 1) rates/Fed plus inflation, 2) labor-growth plus demand, 3) housing supply-prices plus investor cash flow/cap rates. Use conditional language such as may, could, or likely. Never use "will" for forecasts.)

## 12-MONTH DETAIL
(A fuller explanation for the 12-month view. Use 2 short paragraphs or 4 bullet points. Cite specific data points from the context, explain the causal chain, and reference at least one current headline or macro catalyst. When relevant, explicitly connect geopolitical or shipping headlines to oil, CPI/PCE, breakevens, Treasury yields, and mortgage rates.)

## 3-YEAR OUTLOOK
(Exactly 3 bullet points beginning with "-". Each bullet should be a broader overview sentence, not a fragment. Cover: 1) rates/Fed plus inflation, 2) labor-growth plus demand, 3) housing supply-prices plus investor cash flow/cap rates. Use conditional language such as may, could, or likely. Never use "will" for forecasts.)

## 3-YEAR DETAIL
(A fuller explanation for the 3-year view. Use 2 short paragraphs or 4 bullet points. Cite specific data points from the context, explain the causal chain, and reference structural supply, demographics, and macro catalysts.)

## NEWS & CATALYSTS
(Exactly 4 bullet points beginning with "-". Each bullet must mention a concrete current headline, market catalyst, or data release from the provided context and explain why it matters for mortgage rates, inflation, labor demand, or housing.)

## REAL ESTATE IMPLICATIONS
(Exactly 4 bullet points beginning with "-". Quantify expected cap rate range for SFR or multifamily, gross yield range, price-to-rent direction, and whether cash-flow-positive acquisitions may be feasible.)

## KEY RISKS
(Exactly 3 bullet points. Each must cite a specific data point from the context: e.g., "Core PCE at X% above the 2% target means...")

Rules: Use the exact numbers from the data. Integrate the provided macro headlines, Polygon market headlines, Finnhub headlines, and Event Registry headlines as catalysts, not certainties. Do not just mention headlines; explain the economic transmission mechanism from the event into inflation, growth, rates, credit, and housing demand. Treat the macro indicators as trend inputs, not isolated snapshots, and explicitly mention direction when the context provides month-over-month or year-over-year changes. Prefer may, could, likely, or risk over deterministic language. Never use "will" for forecasts unless you are describing a scheduled event. Calculate derived metrics where useful (e.g., real yield = Treasury yield minus inflation).`;

    const parts = [];

    if (housingData) {
      const h = housingData;
      parts.push('**Housing Market Data:**');
      if (h.mortgageRate != null)    parts.push(`- 30-year mortgage rate: ${h.mortgageRate}%`);
      if (h.priceTrend != null)      parts.push(`- Median home price YoY change: ${h.priceTrend > 0 ? '+' : ''}${h.priceTrend}%`);
      if (h.inventoryMonths != null) parts.push(`- Months of supply: ${h.inventoryMonths} (balanced market = 6.0 months)`);
      if (h.medianHomePrice != null) parts.push(`- Median home price: $${Number(h.medianHomePrice).toLocaleString()}`);
      if (h.newListings != null)     parts.push(`- New listings (national): ${Number(h.newListings).toLocaleString()}`);
      if (h.daysOnMarket != null)    parts.push(`- Median days on market: ${h.daysOnMarket}`);
      const medianPriceHistory = formatHistoryWindow('Recent median home price history', h.histories?.medianPrice);
      const inventoryHistory = formatHistoryWindow('Recent inventory history', h.histories?.inventory);
      const mortgageHistory = formatHistoryWindow('Recent housing mortgage history', h.histories?.mortgageRate);
      if (medianPriceHistory) parts.push(medianPriceHistory);
      if (inventoryHistory) parts.push(inventoryHistory);
      if (mortgageHistory) parts.push(mortgageHistory);
    }

    if (treasuryYields) {
      const y = treasuryYields;
      parts.push('\n**Treasury Yields & Spread:**');
      if (y.t2y != null)    parts.push(`- 2-year Treasury: ${y.t2y}%`);
      if (y.t10y != null)   parts.push(`- 10-year Treasury: ${y.t10y}%`);
      if (y.t30y != null)   parts.push(`- 30-year Treasury: ${y.t30y}%`);
      if (y.t2y != null && y.t10y != null) {
        const curveSteepness = (Number(y.t10y) - Number(y.t2y)).toFixed(2);
        const curveLabel = Number(curveSteepness) >= 0 ? 'normal (steepening/flat)' : 'inverted';
        parts.push(`- Yield curve (10Y minus 2Y): ${Number(curveSteepness) > 0 ? '+' : ''}${curveSteepness}% — ${curveLabel}`);
      }
      if (y.spread != null) parts.push(`- Mortgage-to-10Y spread: ${y.spread} bps (historical avg ~170 bps; elevated spread = tight credit conditions)`);
      if (y.tenYearMonthlyChange != null) parts.push(`- 10Y Treasury 1-month change: ${Number(y.tenYearMonthlyChange) >= 0 ? '+' : ''}${Number(y.tenYearMonthlyChange).toFixed(2)} pts`);
      if (y.mortgageMonthlyChange != null) parts.push(`- 30Y mortgage 1-month change: ${Number(y.mortgageMonthlyChange) >= 0 ? '+' : ''}${Number(y.mortgageMonthlyChange).toFixed(2)} pts`);
      if (y.spreadMonthlyChange != null) parts.push(`- Mortgage spread 1-month change: ${Number(y.spreadMonthlyChange) >= 0 ? '+' : ''}${Number(y.spreadMonthlyChange).toFixed(2)} pts`);
      const tenYearHistory = formatHistoryWindow('Recent 10Y Treasury history', y.histories?.tenYear);
      const mortgageRateHistory = formatHistoryWindow('Recent 30Y mortgage history', y.histories?.mortgageRate);
      const spreadHistory = formatHistoryWindow('Recent 10Y-2Y spread history', y.histories?.yieldSpread);
      if (tenYearHistory) parts.push(tenYearHistory);
      if (mortgageRateHistory) parts.push(mortgageRateHistory);
      if (spreadHistory) parts.push(spreadHistory);
    }

    if (macroData) {
      const m = macroData;
      parts.push('\n**Macroeconomic Indicators:**');
      const fedFundsRateValue = parseNumericMetric(m.fedFundsRate);
      const corePceValue = parseNumericMetric(m.corePCE);
      if (fedFundsRateValue !== null) parts.push(`- Federal Funds Rate (target): ${fedFundsRateValue.toFixed(2)}%`);
      if (corePceValue !== null) {
        const realYield = fedFundsRateValue !== null ? (fedFundsRateValue - corePceValue).toFixed(2) : null;
        parts.push(`- Core PCE inflation index: ${getMetricValue(m.corePCE)}${getMetricField(m.corePCE, 'mom') != null ? ` (MoM ${Number(getMetricField(m.corePCE, 'mom')) >= 0 ? '+' : ''}${getMetricField(m.corePCE, 'mom')}%` : ''}${getMetricField(m.corePCE, 'yoy') != null ? `; YoY ${Number(getMetricField(m.corePCE, 'yoy')) >= 0 ? '+' : ''}${getMetricField(m.corePCE, 'yoy')}%` : ''}${realYield !== null ? `; real Fed Funds rate: ${realYield}%` : ''})`);
      }
      if (parseNumericMetric(m.unemployment) !== null) parts.push(`- Unemployment rate: ${parseNumericMetric(m.unemployment)?.toFixed(2)}% (NAIRU ≈ 4.0–4.5%)`);
      if (getMetricValue(m.consumerSentiment) != null) parts.push(`- Consumer sentiment index: ${getMetricValue(m.consumerSentiment)} (pre-COVID avg ≈ 98)`);
      if (parseNumericMetric(m.gdpGrowth) !== null) parts.push(`- Real GDP growth (annualized): ${parseNumericMetric(m.gdpGrowth)?.toFixed(2)}%`);
      if (getMetricValue(m.joblessClaims) != null) parts.push(`- Initial jobless claims: ${getMetricValue(m.joblessClaims)}${getMetricField(m.joblessClaims, 'yoy') != null ? ` (${Number(getMetricField(m.joblessClaims, 'yoy')) >= 0 ? '+' : ''}${getMetricField(m.joblessClaims, 'yoy')}% YoY)` : ''}`);
      if (getMetricValue(m.jobOpenings) != null) parts.push(`- Job openings: ${getMetricValue(m.jobOpenings)}${getMetricField(m.jobOpenings, 'yoy') != null ? ` (${Number(getMetricField(m.jobOpenings, 'yoy')) >= 0 ? '+' : ''}${getMetricField(m.jobOpenings, 'yoy')}% YoY)` : ''}`);
      if (getMetricValue(m.breakeven10Y) != null) parts.push(`- 10Y breakeven inflation: ${getMetricValue(m.breakeven10Y)}%`);
      if (getMetricValue(m.oilPrice) != null) parts.push(`- WTI crude oil spot price: $${getMetricValue(m.oilPrice)}${getMetricField(m.oilPrice, 'yoy') != null ? ` (${Number(getMetricField(m.oilPrice, 'yoy')) >= 0 ? '+' : ''}${getMetricField(m.oilPrice, 'yoy')}% YoY)` : ''}`);
      if (getMetricValue(m.newHomeSales) != null) parts.push(`- New home sales: ${getMetricValue(m.newHomeSales)}`);
      if (getMetricValue(m.constructionPPI) != null) parts.push(`- Construction cost index: ${getMetricValue(m.constructionPPI)}`);
      const knownKeys = new Set(['corePCE', 'unemployment', 'consumerSentiment', 'gdpGrowth', 'fedFundsRate', 'joblessClaims', 'jobOpenings', 'breakeven10Y', 'oilPrice', 'newHomeSales', 'constructionPPI']);
      for (const [k, v] of Object.entries(m)) {
        if (!knownKeys.has(k) && v != null) parts.push(`- ${k}: ${JSON.stringify(v)}`);
      }
    }

    if (macroSignals.length > 0) {
      parts.push('\n**Macro Catalyst Signals:**');
      for (const signal of macroSignals) parts.push(`- ${signal}`);
    }

    if (newsTransmissionSignals.length > 0) {
      parts.push('\n**Derived News Transmission Signals:**');
      for (const signal of newsTransmissionSignals) parts.push(`- ${signal}`);
    }

    if (macroHeadlines.length > 0) {
      parts.push('\n**Recent Macro Headlines:**');
      for (const headline of macroHeadlines) {
        parts.push(`- [${headline.topic}] ${headline.title}${headline.pubDate ? ` (${headline.pubDate})` : ''}`);
      }
    }

    if (polygonNews.length > 0) {
      parts.push('\n**Polygon Market News:**');
      for (const headline of polygonNews) {
        parts.push(`- [${headline.topic} / ${headline.ticker}] ${headline.title}${headline.publisher ? ` — ${headline.publisher}` : ''}${headline.publishedUtc ? ` (${headline.publishedUtc})` : ''}`);
      }
    }

    if (finnhubNews.length > 0) {
      parts.push('\n**Finnhub Macro News:**');
      for (const headline of finnhubNews) {
        parts.push(`- [${headline.topic}] ${headline.title}${headline.source ? ` — ${headline.source}` : ''}${headline.publishedAt ? ` (${headline.publishedAt})` : ''}`);
      }
    }

    if (eventRegistryNews.length > 0) {
      parts.push('\n**Event Registry News:**');
      for (const headline of eventRegistryNews) {
        parts.push(`- [${headline.topic}] ${headline.title}${headline.source ? ` — ${headline.source}` : ''}${headline.publishedAt ? ` (${headline.publishedAt})` : ''}`);
      }
    }

    if (predictions && typeof predictions === 'object') {
      const entries = Object.entries(predictions).filter(([, v]) => v != null);
      if (entries.length) {
        parts.push('\n**Prediction Market Odds (Polymarket):**');
        for (const [label, odds] of entries) parts.push(`- ${label}: ${odds}`);
        parts.push('  (Use these market-implied probabilities to calibrate your outlook uncertainty.)');
      }
    }

    const userMessage = parts.join('\n') || 'Please provide a macro market analysis based on current conditions.';

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[MarketAnalysis] /market/ai-analysis error:', error.message);
    try { res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`); res.end(); } catch (_) { res.end(); }
  }
});

// POST /api/regional/ai-analysis — regional market analysis
router.post('/regional/ai-analysis', async (req, res) => {
  try {
    const { regionName, regionalDetail, beveridgeData, selectedRegion } = req.body;
    startSSE(res);

    const systemPrompt = `You are a regional real estate market analyst with expertise in metro-level housing economics. Analyze the provided metro/CBSA data and deliver a precise, data-backed investment assessment.

Structure your response in these EXACT sections using these headers:
## REGION OVERVIEW
(2-3 sentences on current regime: supply-constrained, over-built, job-growth driven, rate-sensitive, etc. Include the metro's gross yield and price-to-rent ratio if provided.)

## MARKET ATTRACTIVENESS
(Score 1–10. Explain the score with at least 3 specific drivers: rent-to-price ratio, job growth, inventory trend, gross yield vs. cap rate hurdle, or population trajectory. Ground each claim in the data.)

## HOT ZONES
(Bullet list of 3–5 specific sub-market types, ZIP clusters, or asset classes within this metro showing the strongest momentum. Reference the data: e.g., "Gross yield at X% exceeds the metro average by Y bps.")

## WATCH ZONES
(Bullet list of 2–3 segments or sub-markets to approach cautiously — oversupply signals, DOM expansion, rent deceleration, concession trends.)

## LABOR MARKET READ
(Interpret the Beveridge curve data if provided: is this metro in tightening, loosening, or normalized labor conditions? What does that imply for rental demand and wage-driven rent growth?)

## KEY RISKS
(3 bullet points, each citing a specific data point from the context.)

## INVESTMENT THESIS
(4–5 actionable sentences: optimal asset type, price point, hold horizon, and one specific entry signal to watch for. Be concrete — avoid generic statements.)

Rules: Use specific numbers from the data. Calculate gross yield if median rent and median price are both provided (gross yield = annual rent / price × 100). Treat chart data trend direction as a signal.`;

    const parts = [];
    if (regionName)     parts.push(`**Region:** ${regionName}`);
    if (selectedRegion) parts.push(`**CBSA / Region ID:** ${selectedRegion}`);

    // Unpack regionalDetail cleanly
    if (regionalDetail && typeof regionalDetail === 'object') {
      const { overview, charts, zipMarketData } = regionalDetail;

      if (overview && typeof overview === 'object') {
        parts.push('\n**Regional Overview Metrics:**');
        const fmt = (v) => (v?.value != null ? v.value : v);
        const yoy = (v) => (v?.yoy != null ? ` (${v.yoy > 0 ? '+' : ''}${v.yoy}% YoY)` : '');
        if (overview.mortgageRate != null) parts.push(`- 30Y mortgage rate: ${fmt(overview.mortgageRate)}%`);
        if (overview.medianPrice != null)  parts.push(`- Median home price: $${Number(fmt(overview.medianPrice)).toLocaleString()}${yoy(overview.medianPrice)}`);
        if (overview.inventory != null)    parts.push(`- Months of supply: ${fmt(overview.inventory)}`);
        if (overview.newListings != null)  parts.push(`- New listings: ${Number(fmt(overview.newListings)).toLocaleString()}`);
        if (overview.daysOnMarket != null) parts.push(`- Median days on market: ${fmt(overview.daysOnMarket)}`);
        const knownOv = new Set(['mortgageRate','medianPrice','inventory','newListings','daysOnMarket']);
        for (const [k, v] of Object.entries(overview)) {
          if (!knownOv.has(k) && v != null) parts.push(`- ${k}: ${JSON.stringify(v)}`);
        }
      }

      if (zipMarketData && typeof zipMarketData === 'object') {
        parts.push('\n**ZIP-Level Market Data (Rentcast):**');
        if (zipMarketData.zipCode)                    parts.push(`- ZIP Code: ${zipMarketData.zipCode}`);
        if (zipMarketData.medianAskingRent != null)   parts.push(`- Median asking rent: $${Number(zipMarketData.medianAskingRent).toLocaleString()}/mo`);
        if (zipMarketData.medianSalePrice != null)    parts.push(`- Median sale price: $${Number(zipMarketData.medianSalePrice).toLocaleString()}`);
        if (zipMarketData.grossYieldPct != null)      parts.push(`- Gross rental yield: ${Number(zipMarketData.grossYieldPct).toFixed(2)}%`);
        if (zipMarketData.priceToRentRatio != null)   parts.push(`- Price-to-rent ratio: ${Number(zipMarketData.priceToRentRatio).toFixed(1)}x`);
      }

      if (charts && typeof charts === 'object') {
        parts.push('\n**Historical Chart Trends (latest 6 data points per series):**');
        for (const [seriesName, seriesData] of Object.entries(charts)) {
          if (Array.isArray(seriesData) && seriesData.length) {
            const last6 = seriesData.slice(-6);
            const oldest = last6[0]?.value;
            const newest = last6[last6.length - 1]?.value;
            const direction = oldest != null && newest != null
              ? (newest > oldest ? '↑ rising' : newest < oldest ? '↓ falling' : '→ flat')
              : '';
            parts.push(`- ${seriesName}: ${last6.map(p => `${p.date || p.month || '?'}: ${p.value}`).join(', ')} ${direction}`);
          }
        }
      }
    }

    if (beveridgeData && typeof beveridgeData === 'object') {
      parts.push('\n**Labor Market — Beveridge Curve Data:**');
      const bd = beveridgeData;
      if (Array.isArray(bd.data)) {
        const recent = bd.data.slice(-4);
        parts.push(`- Recent quarters (vacancy rate → unemployment rate): ${recent.map(p => `${p.date || p.period || '?'}: vacancies ${p.vacancyRate ?? p.jobOpenings ?? '?'}%, unemployment ${p.unemploymentRate ?? p.unemployment ?? '?'}%`).join(' | ')}`);
      } else {
        for (const [k, v] of Object.entries(bd)) {
          if (v != null) parts.push(`- ${k}: ${JSON.stringify(v)}`);
        }
      }
    }

    const userMessage = parts.join('\n') || `Please analyze the regional real estate market${regionName ? ` for ${regionName}` : ''}.`;

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[MarketAnalysis] /regional/ai-analysis error:', error.message);
    try { res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`); res.end(); } catch (_) { res.end(); }
  }
});

// POST /api/my-region/ai-analysis — hyper-local neighborhood analysis
router.post('/my-region/ai-analysis', async (req, res) => {
  try {
    const { countyName, cbsaName, zipCode, countyData, cbsaData, rentcastData, attomData, neighborhoodName } = req.body;
    startSSE(res);

    const systemPrompt = `You are a hyper-local real estate market analyst with surgical precision on micro-market trends. Assess this specific ZIP code or neighborhood using the provided data — identifying the market phase, investment potential, and actionable plays.

Structure your response in these EXACT sections using these headers:
## NEIGHBORHOOD OVERVIEW
(2-3 sentences: dominant housing stock type, economic base, and current market character. Lead with the gross yield and price-to-rent ratio if available.)

## MARKET PHASE
(Classify exactly as: HEATING / COOLING / STABLE. Justify with at least 3 data points: e.g., DOM trend, rent growth vs. sale price growth, listing velocity. State what will trigger a phase change.)

## BUY SIGNALS
(Bullet list of 3–5 data-backed reasons to acquire investment property here. Include at minimum: gross yield vs. financing cost, days-on-market trend, and appreciation trajectory.)

## RENT SIGNALS
(Bullet list of 3–5 rental demand indicators: vacancy proxy, rent-by-bedroom breakdown, DOM for rentals vs. sales, and any supply/demand imbalance.)

## RISKS
(3 bullet points. Each must reference a specific metric: e.g., "Sale price appreciation at X% is outpacing rent growth at Y%, compressing future yields.")

## OPPORTUNITIES
(3 specific, actionable plays for this ZIP. Format: asset type → price point → expected gross yield → key entry trigger. Example: "3BR SFR under $320K → ~6.1% gross yield → enter when DOM >40 signals negotiating leverage.")

Rules: Use exact numbers from the data. Calculate gross yield = (annual rent / sale price) × 100 if both are provided. Flag when the gross yield falls below the prevailing 30Y mortgage rate as a cash-flow caution signal.`;

    const parts = [];
    if (neighborhoodName) parts.push(`**Neighborhood / Area:** ${neighborhoodName}`);
    if (zipCode)          parts.push(`**ZIP Code:** ${zipCode}`);
    if (cbsaName)         parts.push(`**Metro (CBSA):** ${cbsaName}`);
    if (countyName)       parts.push(`**County:** ${countyName}`);

    if (countyData && typeof countyData === 'object') {
      parts.push('\n**County-Level Economic Data (FRED):**');
      const ue = countyData.unemployment;
      if (ue != null) {
        const ueVal = typeof ue === 'object' ? ue.value : ue;
        const ueDate = typeof ue === 'object' ? ue.date : null;
        if (ueVal != null) parts.push(`- County unemployment rate: ${ueVal}%${ueDate ? ` (${ueDate})` : ''}`);
      }
      const al = countyData.activeListings;
      if (al != null) {
        const alVal = typeof al === 'object' ? al.value : al;
        if (alVal != null) parts.push(`- Active listings (county): ${Number(alVal).toLocaleString()}`);
      }
      const nl = countyData.newListings;
      if (nl != null) {
        const nlVal = typeof nl === 'object' ? nl.value : nl;
        if (nlVal != null) parts.push(`- New listings (county): ${Number(nlVal).toLocaleString()}`);
      }
      const uehist = countyData.unemploymentHistory;
      if (Array.isArray(uehist) && uehist.length >= 2) {
        const oldest = uehist[0]?.value;
        const newest = uehist[uehist.length - 1]?.value;
        const direction = newest > oldest ? 'rising' : newest < oldest ? 'falling' : 'flat';
        const pts = uehist.slice(-3).map(p => `${p.date}: ${p.value}%`).join(', ');
        parts.push(`- County unemployment trend (${uehist.length}mo): ${direction} — recent: ${pts}`);
      }
    }

    if (cbsaData && typeof cbsaData === 'object') {
      parts.push('\n**Metro-Level Data (CBSA):**');
      if (cbsaData.medianIncome != null) parts.push(`- Median household income: $${Number(cbsaData.medianIncome).toLocaleString()}`);
      if (cbsaData.hpiLatest != null)    parts.push(`- House Price Index (latest): ${cbsaData.hpiLatest}`);
      const known = new Set(['medianIncome', 'hpiLatest']);
      for (const [k, v] of Object.entries(cbsaData)) {
        if (!known.has(k) && v != null) parts.push(`- ${k}: ${JSON.stringify(v)}`);
      }
    }
    if (rentcastData && typeof rentcastData === 'object') {
      parts.push('\n**Rental & Sales Market Data (Rentcast):**');
      const r = rentcastData;
      if (r.medianAskingRent != null)  parts.push(`- Median asking rent: $${Number(r.medianAskingRent).toLocaleString()}/mo`);
      if (r.medianSalePrice != null)   parts.push(`- Median sale price: $${Number(r.medianSalePrice).toLocaleString()}`);
      if (r.grossYieldPct != null)     parts.push(`- Gross rental yield: ${Number(r.grossYieldPct).toFixed(2)}%`);
      if (r.priceToRentRatio != null)  parts.push(`- Price-to-rent ratio: ${Number(r.priceToRentRatio).toFixed(1)}x`);
      if (r.rentalDOM != null)         parts.push(`- Rental days on market: ${r.rentalDOM}`);
      if (r.saleDOM != null)           parts.push(`- Sale days on market: ${r.saleDOM}`);
      if (r.rentalListings != null)    parts.push(`- Active rental listings: ${r.rentalListings}`);
      if (r.saleListings != null)      parts.push(`- Active sale listings: ${r.saleListings}`);
      if (Array.isArray(r.rentByBedrooms) && r.rentByBedrooms.length) {
        parts.push(`- Rent by bedroom: ${r.rentByBedrooms.map(b => `${b.bedrooms}BR=$${Number(b.medianRent).toLocaleString()}`).join(', ')}`);
      }
      if (Array.isArray(r.rentByType) && r.rentByType.length) {
        parts.push(`- Rent by type: ${r.rentByType.map(t => `${t.type}=$${Number(t.medianRent).toLocaleString()}`).join(', ')}`);
      }
      if (Array.isArray(r.saleByType) && r.saleByType.length) {
        parts.push(`- Sale price by type: ${r.saleByType.map(t => `${t.type}=$${Number(t.medianPrice).toLocaleString()}`).join(', ')}`);
      }
    }
    if (attomData && typeof attomData === 'object') {
      parts.push('\n**Sales & Appreciation Data (ATTOM):**');
      if (attomData.appreciationRate != null)  parts.push(`- ${attomData.trendMonths || 24}-month appreciation: ${Number(attomData.appreciationRate).toFixed(2)}%`);
      if (attomData.latestMedianSale != null)  parts.push(`- Latest median sale price (ATTOM): $${Number(attomData.latestMedianSale).toLocaleString()}`);
      if (attomData.trendMonths != null)       parts.push(`- ATTOM data coverage: ${attomData.trendMonths} months`);
    }

    const locationLabel = neighborhoodName || zipCode || countyName || 'this area';
    const userMessage = parts.join('\n') || `Please provide a hyper-local market analysis for ${locationLabel}.`;

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[MarketAnalysis] /my-region/ai-analysis error:', error.message);
    try { res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`); res.end(); } catch (_) { res.end(); }
  }
});

function parsePortfolioNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number.parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function firstPortfolioNumber(...values) {
  for (const value of values) {
    const numeric = parsePortfolioNumber(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function normalizePortfolioAddress(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatPortfolioCurrency(value, maximumFractionDigits = 0) {
  const numeric = parsePortfolioNumber(value);
  if (numeric === null) return 'n/a';
  return numeric.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  });
}

function formatPortfolioCompactCurrency(value) {
  const numeric = parsePortfolioNumber(value);
  if (numeric === null) return 'n/a';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(numeric);
}

function formatPortfolioPercent(value, digits = 1) {
  const numeric = parsePortfolioNumber(value);
  if (numeric === null) return 'n/a';
  return `${numeric.toFixed(digits)}%`;
}

function formatSignedPortfolioPercent(value, digits = 1) {
  const numeric = parsePortfolioNumber(value);
  if (numeric === null) return 'n/a';
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(digits)}%`;
}

function formatSignedPortfolioCurrency(value, maximumFractionDigits = 0) {
  const numeric = parsePortfolioNumber(value);
  if (numeric === null) return 'n/a';
  return `${numeric >= 0 ? '+' : '-'}${Math.abs(numeric).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  })}`;
}

async function fetchPolygonPortfolioJSON(url) {
  if (!POLYGON_API_KEY) return null;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'HouseYield/1.0' },
    });

    if (!response.ok) {
      return null;
    }

    return response.json();
  } catch {
    return null;
  }
}

async function enrichPortfolioStockHolding(stock, totalPortfolioValue, totalStockValue) {
  const ticker = String(stock?.ticker || '').trim().toUpperCase();
  if (!ticker) return null;

  const marketValue = firstPortfolioNumber(stock?.value, stock?.marketValue) || 0;
  const costBasis = firstPortfolioNumber(stock?.costBasis, stock?.basis);
  const shares = firstPortfolioNumber(stock?.shares);

  const [companyData, snapshotData, financialsData, newsData] = await Promise.all([
    fetchPolygonPortfolioJSON(`https://api.polygon.io/v3/reference/tickers/${ticker}?apiKey=${POLYGON_API_KEY}`),
    fetchPolygonPortfolioJSON(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_API_KEY}`),
    fetchPolygonPortfolioJSON(`https://api.polygon.io/vX/reference/financials?ticker=${ticker}&limit=1&timeframe=annual&apiKey=${POLYGON_API_KEY}`),
    fetchPolygonPortfolioJSON(`https://api.polygon.io/v2/reference/news?ticker=${ticker}&limit=2&apiKey=${POLYGON_API_KEY}`),
  ]);

  const company = companyData?.results || {};
  const snapshot = snapshotData?.ticker || {};
  const latestFinancial = Array.isArray(financialsData?.results) ? financialsData.results[0] : null;
  const incomeStatement = latestFinancial?.financials?.income_statement || {};
  const balanceSheet = latestFinancial?.financials?.balance_sheet || {};
  const cashFlowStatement = latestFinancial?.financials?.cash_flow_statement || {};

  const currentPrice = firstPortfolioNumber(snapshot?.day?.c, snapshot?.lastTrade?.p, snapshot?.prevDay?.c, stock?.pricePerShare);
  const previousClose = firstPortfolioNumber(snapshot?.prevDay?.c);
  const dayChangePercent = currentPrice !== null && previousClose && previousClose !== 0
    ? ((currentPrice - previousClose) / previousClose) * 100
    : null;

  const overallWeight = totalPortfolioValue > 0 ? (marketValue / totalPortfolioValue) * 100 : 0;
  const sleeveWeight = totalStockValue > 0 ? (marketValue / totalStockValue) * 100 : 0;
  const sector = company.sic_description || stock?.sector || 'Unknown';

  const newsItems = Array.isArray(newsData?.results)
    ? newsData.results.slice(0, 2).map((item) => ({
        title: item?.title || '',
        source: item?.publisher?.name || 'Polygon',
        publishedAt: item?.published_utc || null,
        ticker,
      })).filter((item) => item.title)
    : [];

  const details = [
    `${ticker} (${company?.name || stock?.name || ticker})`,
    `overall weight ${formatPortfolioPercent(overallWeight, 2)}`,
    totalStockValue > 0 ? `stock sleeve ${formatPortfolioPercent(sleeveWeight, 2)}` : null,
    `market value ${formatPortfolioCurrency(marketValue)}`,
    shares !== null ? `${shares.toLocaleString('en-US', { maximumFractionDigits: 4 })} shares` : null,
    costBasis !== null ? `unrealized ${formatSignedPortfolioCurrency(marketValue - costBasis)}` : null,
    currentPrice !== null ? `price ${formatPortfolioCurrency(currentPrice, 2)}` : null,
    dayChangePercent !== null ? `1D ${formatSignedPortfolioPercent(dayChangePercent, 2)}` : null,
    sector ? `sector ${sector}` : null,
    company?.market_cap ? `market cap ${formatPortfolioCompactCurrency(company.market_cap)}` : null,
    incomeStatement?.revenues?.value ? `revenue ${formatPortfolioCompactCurrency(incomeStatement.revenues.value)}` : null,
    incomeStatement?.net_income_loss?.value ? `net income ${formatPortfolioCompactCurrency(incomeStatement.net_income_loss.value)}` : null,
    cashFlowStatement?.net_cash_flow_from_operating_activities?.value ? `operating cash flow ${formatPortfolioCompactCurrency(cashFlowStatement.net_cash_flow_from_operating_activities.value)}` : null,
    balanceSheet?.liabilities?.value && balanceSheet?.equity?.value
      ? `debt/equity ${(balanceSheet.liabilities.value / Math.max(balanceSheet.equity.value, 1)).toFixed(2)}x`
      : null,
    newsItems.length > 0 ? `recent news: ${newsItems.map((item) => item.title).join(' | ')}` : null,
  ].filter(Boolean);

  return {
    ticker,
    sector,
    marketValue,
    analysisValue: marketValue,
    line: `- ${details.join(' | ')}`,
    newsItems,
  };
}

function summarizePortfolioRealEstateHoldings({
  realEstateAssets = [],
  ownerProperties = [],
  realEstateHoldings = [],
  liabilities = [],
  totalPortfolioValue = 0,
  viewMode = 'assets',
}) {
  const ownerById = new Map();
  const ownerByAddress = new Map();
  const holdingById = new Map();
  const holdingByAddress = new Map();
  const liabilityByAssetId = new Map();

  for (const property of ownerProperties) {
    if (property?.id) ownerById.set(String(property.id), property);
    const normalizedAddress = normalizePortfolioAddress(property?.address);
    if (normalizedAddress) ownerByAddress.set(normalizedAddress, property);
  }

  for (const holding of realEstateHoldings) {
    if (holding?.id) holdingById.set(String(holding.id), holding);
    const normalizedAddress = normalizePortfolioAddress(holding?.address);
    if (normalizedAddress) holdingByAddress.set(normalizedAddress, holding);
  }

  for (const liability of liabilities) {
    if (liability?.linkedAssetId) {
      liabilityByAssetId.set(String(liability.linkedAssetId), liability);
    }
  }

  const lines = [];
  const holdings = [];
  let totalPropertyValue = 0;
  let totalPropertyEquity = 0;
  let totalMonthlyRent = 0;
  let totalMonthlyCashFlow = 0;
  let propertiesWithCashFlow = 0;
  let elevatedFloodRiskCount = 0;
  let elevatedFireRiskCount = 0;

  for (const asset of realEstateAssets.slice(0, 12)) {
    const assetId = asset?.id ? String(asset.id) : '';
    const assetAddress = asset?.address || asset?.name || '';
    const normalizedAddress = normalizePortfolioAddress(assetAddress);
    const ownerMatch = (assetId && ownerById.get(assetId)) || ownerByAddress.get(normalizedAddress) || null;
    const holdingMatch = (assetId && holdingById.get(assetId)) || holdingByAddress.get(normalizedAddress) || null;
    const liabilityMatch = (assetId && liabilityByAssetId.get(assetId)) || null;
    const propertyData = ownerMatch?.propertyData || ownerMatch?.property_data || {};
    const summary = propertyData?.summary || {};
    const financials = ownerMatch?.financials || {};

    const currentValue = firstPortfolioNumber(asset?.value, holdingMatch?.currentValue, summary?.avm_value, financials?.currentValue, financials?.purchasePrice) || 0;
    const loanBalance = firstPortfolioNumber(liabilityMatch?.balance, financials?.loanAmount, holdingMatch?.loanAmount) || 0;
    const equity = Math.max(currentValue - loanBalance, 0);
    const monthlyRent = firstPortfolioNumber(financials?.monthlyRent, holdingMatch?.monthlyRent, summary?.rental_avm);
    const monthlyExpenses = firstPortfolioNumber(financials?.monthlyExpenses, holdingMatch?.monthlyExpenses);
    const monthlyDebtService = firstPortfolioNumber(liabilityMatch?.monthlyPayment, financials?.monthlyMortgage, financials?.monthlyPayment, holdingMatch?.monthlyPayment);
    const monthlyCashFlow = monthlyRent !== null
      ? monthlyRent - (monthlyExpenses || 0) - (monthlyDebtService || 0)
      : null;
    const propertyTax = firstPortfolioNumber(financials?.propertyTax, summary?.tax_current, propertyData?.tax_history?.[0]?.tax_amount);
    const grossYield = monthlyRent !== null && currentValue > 0 ? ((monthlyRent * 12) / currentValue) * 100 : null;
    const netYield = monthlyCashFlow !== null && currentValue > 0 ? ((monthlyCashFlow * 12) / currentValue) * 100 : null;
    const avmHistory = Array.isArray(propertyData?.avm_history) ? propertyData.avm_history : [];
    const startAvm = avmHistory[0]?.value;
    const endAvm = avmHistory[avmHistory.length - 1]?.value;
    const avmTrend = startAvm && endAvm ? ((endAvm - startAvm) / startAvm) * 100 : null;
    const hazardScores = summary?.hazard_scores || propertyData?.hazard_scores || {};
    const floodRisk = parsePortfolioNumber(hazardScores?.flood);
    const fireRisk = parsePortfolioNumber(hazardScores?.fire);
    const analysisValue = viewMode === 'equity' ? equity : currentValue;
    const overallWeight = totalPortfolioValue > 0 ? (analysisValue / totalPortfolioValue) * 100 : 0;

    totalPropertyValue += currentValue;
    totalPropertyEquity += equity;

    if (monthlyRent !== null) {
      totalMonthlyRent += monthlyRent;
    }

    if (monthlyCashFlow !== null) {
      totalMonthlyCashFlow += monthlyCashFlow;
      propertiesWithCashFlow += 1;
    }

    if (floodRisk !== null && floodRisk >= 60) elevatedFloodRiskCount += 1;
    if (fireRisk !== null && fireRisk >= 60) elevatedFireRiskCount += 1;

    const line = [
      ownerMatch?.address || holdingMatch?.address || assetAddress || 'Property',
      `overall weight ${formatPortfolioPercent(overallWeight, 2)}`,
      `market value ${formatPortfolioCurrency(currentValue)}`,
      loanBalance > 0 ? `equity ${formatPortfolioCurrency(equity)}` : null,
      monthlyRent !== null ? `rent ${formatPortfolioCurrency(monthlyRent)}/mo` : null,
      monthlyCashFlow !== null ? `cash flow ${formatSignedPortfolioCurrency(monthlyCashFlow)}/mo` : null,
      grossYield !== null ? `gross yield ${formatPortfolioPercent(grossYield, 1)}` : null,
      netYield !== null ? `net yield ${formatPortfolioPercent(netYield, 1)}` : null,
      propertyTax !== null ? `tax ${formatPortfolioCurrency(propertyTax)}/yr` : null,
      summary?.property_type ? `type ${summary.property_type}` : null,
      summary?.year_built ? `built ${summary.year_built}` : null,
      summary?.living_sqft ? `${Number(summary.living_sqft).toLocaleString('en-US')} sqft` : null,
      avmTrend !== null ? `AVM trend ${formatSignedPortfolioPercent(avmTrend, 1)} over cached history` : null,
      floodRisk !== null && floodRisk >= 60 ? `flood risk ${formatPortfolioPercent(floodRisk, 0)}` : null,
      fireRisk !== null && fireRisk >= 60 ? `fire risk ${formatPortfolioPercent(fireRisk, 0)}` : null,
    ].filter(Boolean).join(' | ');

    holdings.push({
      name: ownerMatch?.address || holdingMatch?.address || assetAddress || 'Property',
      value: analysisValue,
      type: 'real-estate',
    });
    lines.push(`- ${line}`);
  }

  return {
    lines,
    holdings,
    totals: {
      totalPropertyValue,
      totalPropertyEquity,
      totalMonthlyRent,
      totalMonthlyCashFlow,
      propertiesWithCashFlow,
      elevatedFloodRiskCount,
      elevatedFireRiskCount,
    },
  };
}

// POST /api/portfolio/allocation-ai-analysis — mixed stock and real estate allocation analysis
router.post('/portfolio/allocation-ai-analysis', async (req, res) => {
  try {
    startSSE(res);

    const portfolio = req.body?.portfolio || {};
    const viewMode = portfolio?.viewMode === 'equity' ? 'equity' : 'assets';
    const allocations = Array.isArray(portfolio?.allocations) ? portfolio.allocations : [];
    const stockHoldings = Array.isArray(portfolio?.stocks)
      ? portfolio.stocks.filter((holding) => String(holding?.ticker || '').trim() && (firstPortfolioNumber(holding?.value, holding?.marketValue) || 0) > 0)
      : [];
    const realEstateAssets = Array.isArray(portfolio?.realEstateAssets)
      ? portfolio.realEstateAssets.filter((asset) => (firstPortfolioNumber(asset?.value) || 0) > 0)
      : [];
    const ownerProperties = Array.isArray(portfolio?.ownerProperties) ? portfolio.ownerProperties : [];
    const realEstateHoldings = Array.isArray(portfolio?.realEstateHoldings) ? portfolio.realEstateHoldings : [];
    const liabilities = Array.isArray(portfolio?.liabilities) ? portfolio.liabilities : [];

    if (stockHoldings.length === 0 && realEstateAssets.length === 0) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'No stock or real estate holdings available for analysis.' })}\n\n`);
      res.end();
      return;
    }

    const totalPortfolioValue = firstPortfolioNumber(
      portfolio?.totalValue,
      allocations.reduce((sum, item) => sum + (firstPortfolioNumber(item?.value) || 0), 0)
    ) || 0;
    const totalStockValue = stockHoldings.reduce((sum, holding) => sum + (firstPortfolioNumber(holding?.value, holding?.marketValue) || 0), 0);

    const stockContexts = (await Promise.all(
      stockHoldings
        .slice(0, 12)
        .map((holding) => enrichPortfolioStockHolding(holding, totalPortfolioValue, totalStockValue))
    )).filter(Boolean);

    const stockNews = dedupeNewsItems(
      stockContexts.flatMap((context) => context.newsItems || []),
      10
    );

    if (stockNews.length > 0) {
      res.write(`data: ${JSON.stringify({
        type: 'context',
        context: {
          polygonNews: stockNews,
        },
      })}\n\n`);
    }

    const realEstateSummary = summarizePortfolioRealEstateHoldings({
      realEstateAssets,
      ownerProperties,
      realEstateHoldings,
      liabilities,
      totalPortfolioValue,
      viewMode,
    });

    const combinedHoldings = [
      ...stockContexts.map((context) => ({ name: context.ticker, value: context.analysisValue, type: 'stock' })),
      ...realEstateSummary.holdings,
    ].sort((left, right) => right.value - left.value);

    const topThreeConcentration = totalPortfolioValue > 0
      ? (combinedHoldings.slice(0, 3).reduce((sum, holding) => sum + holding.value, 0) / totalPortfolioValue) * 100
      : 0;

    const sectorExposure = Array.from(
      stockContexts.reduce((accumulator, context) => {
        const currentValue = accumulator.get(context.sector) || 0;
        accumulator.set(context.sector, currentValue + context.marketValue);
        return accumulator;
      }, new Map())
    )
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([sector, value]) => `${sector}: ${formatPortfolioPercent(totalStockValue > 0 ? (value / totalStockValue) * 100 : 0, 1)} of stocks / ${formatPortfolioPercent(totalPortfolioValue > 0 ? (value / totalPortfolioValue) * 100 : 0, 1)} overall`);

    const weightedGrossYield = realEstateSummary.totals.totalPropertyValue > 0 && realEstateSummary.totals.totalMonthlyRent > 0
      ? ((realEstateSummary.totals.totalMonthlyRent * 12) / realEstateSummary.totals.totalPropertyValue) * 100
      : null;

    const parts = [];
    parts.push('**Portfolio Scope:**');
    parts.push(`- Analysis basis: ${viewMode === 'equity' ? 'net worth / equity' : 'market value / assets'}`);
    parts.push(`- Total analyzed value: ${formatPortfolioCurrency(totalPortfolioValue)}`);
    parts.push(`- Holdings analyzed: ${stockContexts.length} stocks and ${realEstateSummary.lines.length} real-estate assets`);
    parts.push(`- Top 3 combined-holding concentration: ${formatPortfolioPercent(topThreeConcentration, 1)}`);

    if (allocations.length > 0) {
      parts.push('\n**Asset Class Mix:**');
      for (const allocation of allocations) {
        parts.push(`- ${allocation.label}: ${formatPortfolioPercent(allocation.percentage, 1)} | ${formatPortfolioCurrency(allocation.value)}`);
      }
    }

    if (combinedHoldings.length > 0) {
      parts.push('\n**Largest Combined Holdings:**');
      for (const holding of combinedHoldings.slice(0, 6)) {
        const holdingWeight = totalPortfolioValue > 0 ? (holding.value / totalPortfolioValue) * 100 : 0;
        parts.push(`- ${holding.name} (${holding.type}): ${formatPortfolioCurrency(holding.value)} | ${formatPortfolioPercent(holdingWeight, 2)} overall weight`);
      }
    }

    if (stockContexts.length > 0) {
      parts.push('\n**Stock Holdings (Massive/Polygon + portfolio data):**');
      for (const context of stockContexts) {
        parts.push(context.line);
      }
    }

    if (sectorExposure.length > 0) {
      parts.push('\n**Equity Sector Exposure:**');
      for (const line of sectorExposure) {
        parts.push(`- ${line}`);
      }
    }

    if (realEstateSummary.lines.length > 0) {
      parts.push('\n**Real Estate Holdings (database + cached ATTOM/property data):**');
      for (const line of realEstateSummary.lines) {
        parts.push(line);
      }

      parts.push('\n**Real Estate Aggregates:**');
      parts.push(`- Total property market value: ${formatPortfolioCurrency(realEstateSummary.totals.totalPropertyValue)}`);
      parts.push(`- Total property equity: ${formatPortfolioCurrency(realEstateSummary.totals.totalPropertyEquity)}`);
      if (realEstateSummary.totals.totalMonthlyRent > 0) {
        parts.push(`- Aggregate monthly rent/run-rate: ${formatPortfolioCurrency(realEstateSummary.totals.totalMonthlyRent)}/mo`);
      }
      if (realEstateSummary.totals.propertiesWithCashFlow > 0) {
        parts.push(`- Aggregate monthly cash flow where expense data exists: ${formatSignedPortfolioCurrency(realEstateSummary.totals.totalMonthlyCashFlow)}/mo across ${realEstateSummary.totals.propertiesWithCashFlow} properties`);
      }
      if (weightedGrossYield !== null) {
        parts.push(`- Weighted gross yield: ${formatPortfolioPercent(weightedGrossYield, 1)}`);
      }
      if (realEstateSummary.totals.elevatedFloodRiskCount > 0 || realEstateSummary.totals.elevatedFireRiskCount > 0) {
        parts.push(`- Elevated physical-risk flags: ${realEstateSummary.totals.elevatedFloodRiskCount} flood, ${realEstateSummary.totals.elevatedFireRiskCount} fire`);
      }
    }

    if (stockNews.length > 0) {
      parts.push('\n**Recent Stock News Catalysts:**');
      for (const item of stockNews) {
        parts.push(`- [${item.ticker}] ${item.title}${item.publishedAt ? ` (${item.publishedAt})` : ''}`);
      }
    }

    const systemPrompt = `You are a senior cross-asset portfolio analyst applying an investment philosophy inspired by Joseph Carlson's compounding-machine framework. Analyze mixed stock and real-estate portfolios using the exact structured data provided.

  Core philosophy you must use:
  1. Buy, hold, and maintain a portfolio of compounding machines with a disciplined and long-term approach. Never reward speculation, gambling, fear, FOMO, hype, or crowd-following.
  2. For stock selection, favor monopoly or entrenched market position, pricing power, operating leverage, organic growth, capital-light economics, and smart capital allocation. Penalize risky reinvestment, acquisition-led growth outside the core franchise, undisciplined use of cash flow, unpredictable cash flows, dilution or governance misalignment, and deteriorating predictability.
  3. For temperament, emphasize discipline, patience, unemotional decision-making, and long-term focus. Only discuss traits that can be inferred from holdings, concentration, and position sizing. Do not invent trading history, emotions, or behavior that is not supported by the portfolio data.
  4. For intrinsic value, focus on organic revenue growth, free-cash-flow-per-share growth, buyback or dilution direction, and improving predictability. Discuss whether the available evidence supports a high-quality compounding profile and whether the current setup appears disciplined relative to intrinsic value, but avoid false precision when valuation inputs are incomplete.
  5. For portfolio management, emphasize smart position sizing, specific buy criteria, specific sell criteria, and intrinsic-value awareness. Under this philosophy, buying more should only make sense for high-quality compounding machines when quality remains intact and valuation is reasonable; trimming or selling should only be discussed when the original thesis appears wrong, quality standards deteriorate, predictability worsens, leverage becomes imprudent, or a materially better opportunity exists.
  6. Translate the same philosophy to real estate by evaluating scarcity or moat, rent pricing power, operating leverage from stable occupancy and fixed-cost absorption, organic NOI or rent growth, capital intensity versus capital-light durability, predictable cash flows, disciplined leverage, and smart capital allocation. Penalize heavy surprise CAPEX, unstable tenancy, weak rent coverage, or leverage that requires benign macro conditions to work.
  7. Weight the evidence in this order: first long-term business or property quality, second predictability and capital allocation, third valuation or intrinsic-value discipline, and only then recent news or catalysts. News is secondary context, not the primary reason a holding qualifies or fails.
  8. A high-quality business is not automatically a well-managed position. Distinguish clearly between business quality and portfolio-management quality; concentration may be justified only when quality is exceptional and position sizing is still prudent.

  Write in the style of a disciplined long-term quality investor, not a sell-side strategist or macro pundit. Keep the language plain enough for an investor dashboard. Ground every claim in the supplied numbers, holdings, sectors, property economics, cached ATTOM property fields, liability data, and Polygon/Massive stock enrichment. If data is missing for a holding, say so briefly instead of inventing facts.

  Structure your response in these EXACT sections using these headers:
  ## PORTFOLIO OVERVIEW
  (2-3 sentences summarizing the portfolio's current mix, what is driving the allocation, whether the view is based on assets or equity, the most important concentration fact, and whether the portfolio broadly resembles a compounding-machine portfolio.)

  ## PHILOSOPHY FIT
  (2 short paragraphs. Explicitly analyze how well the portfolio aligns with the philosophy's core filters: monopoly or scarcity, pricing power, operating leverage, organic growth, capital intensity, smart capital allocation, predictability, dilution or buyback behavior, and disciplined leverage. Cover both stocks and real estate. Separate true compounding-machine traits from anti-patterns.)

  ## QUALITIES
  (2 short paragraphs. Explain the strongest attributes of the portfolio, explicitly analyzing both the stock sleeve and the real-estate sleeve. Reference competitive advantages, balance-sheet quality, cash generation, property cash flow or rent support, embedded equity, and diversification benefits where supported by the data.)

  ## RISKS
  (2 short paragraphs. Explain the most important risks across both stocks and real estate. Cover concentration, valuation sensitivity, sector or regulatory exposure, leverage, cash-flow fragility, property-specific or physical-risk issues, and any signs of unpredictability, capital intensity, or questionable capital allocation when present in the data.)

  ## STOCK HOLDINGS
  (Bullet list. One bullet per stock. Each bullet must mention the ticker, overall portfolio weight, and explicitly tie the holding to at least one philosophy criterion such as pricing power, organic growth, capital allocation, dilution or buybacks, predictability, or a red flag. State whether it looks more like a compounding machine or a philosophy exception.)

  ## REAL ESTATE HOLDINGS
  (Bullet list. One bullet per property. Each bullet must mention the property or address, overall portfolio weight, and the most important philosophy-based takeaway such as rent pricing power, predictability of cash flow, embedded equity, leverage discipline, capital intensity, valuation trend, or hazard flag. State whether it resembles a durable compounding asset or a more cyclical, capital-hungry asset.)

  ## INTRINSIC VALUE LENS
  (1 short paragraph plus 3 bullet points. Discuss what the current data does and does not allow you to say about intrinsic value. Focus on organic growth, free-cash-flow quality, predictability, and disciplined underwriting. If a reliable intrinsic-value estimate cannot be made from the supplied inputs, say that clearly and explain what is missing.)

  ## DIVERSIFICATION & CONCENTRATION
  (4 bullet points. Quantify concentration, mention dominant sectors or property exposures, and assess whether position sizing appears consistent with the philosophy's smart-position-sizing discipline.)

  ## WATCHPOINTS
  (4 bullet points. Give the concrete metrics or catalysts the investor should monitor next, tied directly to named holdings or portfolio exposures, and frame them in terms of the philosophy's buy, hold, trim, or sell discipline.)

  Rules:
  - Use the exact numbers from the context when possible.
  - Analyze stocks and real estate together, not as disconnected lists.
  - Evaluate holdings through the compounding-machine and intrinsic-value lens, not generic factor commentary.
  - Treat recent headlines as secondary catalysts only; do not cite publisher names or media sources in the answer body.
  - Do not let news outweigh multi-year quality, predictability, dilution or buyback behavior, or underwriting evidence.
  - Do not use markdown tables.
  - Prefer may, could, likely, or risk instead of deterministic language.
  - Do not mention missing APIs, prompts, or internal tooling names in the answer body.
  - Keep each paragraph dense and specific rather than generic.
  - Do not psychoanalyze the user; limit temperament commentary to what can be supported by concentration, diversification, and visible position sizing.`;

    const userMessage = parts.join('\n') || 'Provide a portfolio allocation analysis for the supplied stock and real estate holdings.';

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        res.write(`data: ${JSON.stringify({ type: 'delta', text: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('[MarketAnalysis] /portfolio/allocation-ai-analysis error:', error.message);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    } catch (_) {
      res.end();
    }
  }
});

// GET /api/my-region/attom — fetch ATTOM sales trend + appreciation for a ZIP
router.get('/my-region/attom', async (req, res) => {
  try {
    const { zipCode } = req.query;
    if (!zipCode) return res.status(400).json({ ok: false, error: 'zipCode query param is required' });

    const now = new Date();
    const twoYearsAgo = new Date(now);
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    const startDate = req.query.startDate || twoYearsAgo.toISOString().split('T')[0];
    const endDate   = req.query.endDate   || now.toISOString().split('T')[0];
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = `my-region-attom:${String(zipCode).trim()}:${startDate}:${endDate}`;

    const loadAttomPayload = async () => {
      const [trendResult, appreciationResult] = await Promise.allSettled([
        fetchZipSalesTrend(zipCode, startDate, endDate),
        calculateZipAppreciation(zipCode, startDate, endDate),
      ]);

      return {
        ok: true,
        zipCode,
        salesTrend: trendResult.status === 'fulfilled'
          ? trendResult.value
          : { ok: false, error: trendResult.reason?.message || 'fetch_failed' },
        appreciation: appreciationResult.status === 'fulfilled'
          ? appreciationResult.value
          : { ok: false, error: appreciationResult.reason?.message || 'fetch_failed' },
      };
    };

    if (!forceRefresh) {
      const cached = await getCachedFredData(cacheKey).catch(() => null);
      if (cached && !cached.stale) {
        return res.json({ ...cached.data, cached: true, cachedAt: cached.updatedAt });
      }

      if (cached?.data) {
        try {
          const fresh = await loadAttomPayload();
          setCachedFredData(cacheKey, fresh).catch((error) => console.warn(`[Cache] write error for ${cacheKey}:`, error.message));
          return res.json({ ...fresh, refreshedFromStaleCache: true, previousCachedAt: cached.updatedAt });
        } catch (refreshError) {
          console.warn(`[Cache] ${cacheKey} synchronous refresh failed:`, refreshError.message);
          return res.json({ ...cached.data, cached: true, stale: true, cachedAt: cached.updatedAt });
        }
      }
    }

    const payload = await loadAttomPayload();
    setCachedFredData(cacheKey, payload).catch((error) => console.warn(`[Cache] write error for ${cacheKey}:`, error.message));
    return res.json(payload);
  } catch (error) {
    console.error('[MarketAnalysis] /my-region/attom error:', error.message);
    return res.status(500).json({ ok: false, error: error.message || 'attom_fetch_failed' });
  }
});

// GET /api/my-region/rental-comps — fetch rental listing comparables from Rentcast
router.get('/my-region/rental-comps', async (req, res) => {
  try {
    const { zipCode, lat, lng, beds, propType } = req.query;

    if (!zipCode && (!lat || !lng)) {
      return res.status(400).json({ ok: false, error: 'zipCode or lat+lng query params are required' });
    }

    const result = await getRentalListingComparables({
      zipCode,
      latitude:     lat,
      longitude:    lng,
      bedrooms:     beds,
      propertyType: propType,
    });

    return res.json(result);
  } catch (error) {
    console.error('[MarketAnalysis] /my-region/rental-comps error:', error.message);
    return res.status(500).json({ ok: false, error: error.message || 'rental_comps_failed' });
  }
});

export default router;
