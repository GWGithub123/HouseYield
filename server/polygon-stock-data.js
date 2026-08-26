const POLYGON_API_KEY = process.env.POLYGON_API_KEY || process.env.VITE_POLYGON_API_KEY || '';

function normalizeTicker(ticker) {
  return String(ticker || '').trim().toUpperCase();
}

function assertPolygonConfigured() {
  if (!POLYGON_API_KEY) {
    throw new Error('polygon_not_configured');
  }
}

async function polygonGetJSON(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (response.status === 429) {
    throw new Error('polygon_rate_limited');
  }

  if (!response.ok) {
    throw new Error(`polygon_http_${response.status}`);
  }

  return response.json();
}

export async function getPolygonCompanyDetails(ticker) {
  assertPolygonConfigured();

  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;

  const data = await polygonGetJSON(
    `https://api.polygon.io/v3/reference/tickers/${symbol}?apiKey=${POLYGON_API_KEY}`
  );

  if (!data?.results) return null;

  const result = data.results;
  return {
    ticker: result.ticker,
    name: result.name,
    description: result.description || '',
    homepageUrl: result.homepage_url || '',
    logoUrl: result.branding?.icon_url
      ? `${result.branding.icon_url}?apiKey=${POLYGON_API_KEY}`
      : result.branding?.logo_url
        ? `${result.branding.logo_url}?apiKey=${POLYGON_API_KEY}`
        : '',
    listDate: result.list_date || '',
    marketCap: result.market_cap || 0,
    totalEmployees: result.total_employees || 0,
    primaryExchange: result.primary_exchange || '',
    sector: result.sic_description || '',
    industry: result.sic_description || '',
    address: {
      address1: result.address?.address1 || '',
      city: result.address?.city || '',
      state: result.address?.state || '',
      postalCode: result.address?.postal_code || '',
    },
    phoneNumber: result.phone_number || '',
  };
}

export async function getPolygonQuote(ticker) {
  assertPolygonConfigured();

  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;

  const [snapshotData, prevCloseData] = await Promise.all([
    polygonGetJSON(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${POLYGON_API_KEY}`).catch(() => null),
    polygonGetJSON(`https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${POLYGON_API_KEY}`).catch(() => null),
  ]);

  const snapshot = snapshotData?.ticker;
  const prevClose = prevCloseData?.results?.[0];

  if (!snapshot && !prevClose) return null;

  const currentPrice = snapshot?.day?.c || snapshot?.lastTrade?.p || prevClose?.c || 0;
  const previousClose = snapshot?.prevDay?.c || prevClose?.c || 0;
  const change = currentPrice - previousClose;
  const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

  return {
    ticker: symbol,
    currentPrice,
    previousClose,
    open: snapshot?.day?.o || prevClose?.o || 0,
    high: snapshot?.day?.h || prevClose?.h || 0,
    low: snapshot?.day?.l || prevClose?.l || 0,
    volume: snapshot?.day?.v || prevClose?.v || 0,
    vwap: snapshot?.day?.vw || prevClose?.vw || 0,
    change,
    changePercent,
    fiftyTwoWeekHigh: snapshot?.prevDay?.h || 0,
    fiftyTwoWeekLow: snapshot?.prevDay?.l || 0,
    marketStatus: snapshot?.market?.status || 'unknown',
  };
}

export async function getPolygonDividends(ticker, limit = 20) {
  assertPolygonConfigured();

  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const data = await polygonGetJSON(
    `https://api.polygon.io/v3/reference/dividends?ticker=${symbol}&limit=${limit}&apiKey=${POLYGON_API_KEY}`
  );

  return Array.isArray(data?.results)
    ? data.results.map((dividend) => ({
        cashAmount: dividend.cash_amount || 0,
        declarationDate: dividend.declaration_date || '',
        exDividendDate: dividend.ex_dividend_date || '',
        payDate: dividend.pay_date || '',
        frequency: dividend.frequency || 0,
        dividendType: dividend.dividend_type || 'CD',
      }))
    : [];
}

export async function getPolygonHistoricalDividends(ticker, from, to, limit = 100) {
  assertPolygonConfigured();

  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const params = new URLSearchParams({
    ticker: symbol,
    limit: String(limit),
    apiKey: POLYGON_API_KEY,
  });
  if (from) params.set('ex_dividend_date.gte', from);
  if (to) params.set('ex_dividend_date.lte', to);

  const data = await polygonGetJSON(`https://api.polygon.io/v3/reference/dividends?${params.toString()}`);

  return Array.isArray(data?.results)
    ? data.results.map((dividend) => ({
        cashAmount: dividend.cash_amount || 0,
        declarationDate: dividend.declaration_date || '',
        exDividendDate: dividend.ex_dividend_date || '',
        payDate: dividend.pay_date || '',
        frequency: dividend.frequency || 0,
        dividendType: dividend.dividend_type || 'CD',
      }))
    : [];
}

export async function getPolygonFinancials(ticker, timeframe = 'quarterly', limit = 20) {
  assertPolygonConfigured();

  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const data = await polygonGetJSON(
    `https://api.polygon.io/vX/reference/financials?ticker=${symbol}&limit=${limit}&timeframe=${timeframe}&apiKey=${POLYGON_API_KEY}`
  );

  if (!Array.isArray(data?.results)) return [];

  const quarterOrder = {
    Q1: 1,
    Q2: 2,
    Q3: 3,
    Q4: 4,
    FY: 4,
  };

  const mapped = data.results.map((financial) => {
    const income = financial.financials?.income_statement || {};
    const balance = financial.financials?.balance_sheet || {};
    const cashFlow = financial.financials?.cash_flow_statement || {};
    const compData = financial.financials?.comprehensive_income || {};

    return {
      ticker: symbol,
      filingDate: financial.filing_date || '',
      fiscalPeriod: financial.fiscal_period || '',
      fiscalYear: financial.fiscal_year || '',
      revenues: income.revenues?.value || 0,
      netIncome: income.net_income_loss?.value || compData.comprehensive_income_loss?.value || 0,
      grossProfit: income.gross_profit?.value || 0,
      operatingExpenses: income.operating_expenses?.value || 0,
      operatingIncome: income.operating_income_loss?.value || 0,
      earningsPerShare: income.basic_earnings_per_share?.value || 0,
      earningsPerShareDiluted: income.diluted_earnings_per_share?.value || 0,
      totalAssets: balance.assets?.value || 0,
      totalLiabilities: balance.liabilities?.value || 0,
      totalEquity: balance.equity?.value || 0,
      currentAssets: balance.current_assets?.value || 0,
      currentLiabilities: balance.current_liabilities?.value || 0,
      cash: balance.cash?.value || 0,
      operatingCashFlow: cashFlow.net_cash_flow_from_operating_activities?.value || 0,
      investingCashFlow: cashFlow.net_cash_flow_from_investing_activities?.value || 0,
      financingCashFlow: cashFlow.net_cash_flow_from_financing_activities?.value || 0,
      freeCashFlow: (cashFlow.net_cash_flow_from_operating_activities?.value || 0) - Math.abs(cashFlow.net_cash_flow_from_investing_activities?.value || 0),
      peRatio: 0,
      priceToBook: 0,
      debtToEquity: balance.equity?.value ? (balance.liabilities?.value || 0) / balance.equity.value : 0,
    };
  });

  mapped.sort((left, right) => {
    const yearDiff = Number(right.fiscalYear || 0) - Number(left.fiscalYear || 0);
    if (yearDiff !== 0) return yearDiff;

    const periodDiff = (quarterOrder[right.fiscalPeriod] || 0) - (quarterOrder[left.fiscalPeriod] || 0);
    if (periodDiff !== 0) return periodDiff;

    return String(right.filingDate || '').localeCompare(String(left.filingDate || ''));
  });

  return mapped;
}

export async function getPolygonStockNews(ticker, limit = 10) {
  assertPolygonConfigured();

  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const data = await polygonGetJSON(
    `https://api.polygon.io/v2/reference/news?ticker=${symbol}&limit=${limit}&apiKey=${POLYGON_API_KEY}`
  );

  return Array.isArray(data?.results)
    ? data.results.map((news) => ({
        id: news.id || '',
        title: news.title || '',
        description: news.description || '',
        articleUrl: news.article_url || '',
        imageUrl: news.image_url || '',
        publishedUtc: news.published_utc || '',
        publisher: {
          name: news.publisher?.name || '',
          logoUrl: news.publisher?.logo_url || '',
        },
        tickers: news.tickers || [],
      }))
    : [];
}

export async function getPolygonHistoricalPrices(ticker, from, to, timespan = 'day') {
  assertPolygonConfigured();

  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const data = await polygonGetJSON(
    `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_API_KEY}`
  );

  if (!Array.isArray(data?.results)) return [];

  const prices = data.results.map((price) => ({
    date: new Date(price.t).toISOString().split('T')[0],
    open: price.o || 0,
    high: price.h || 0,
    low: price.l || 0,
    close: price.c || 0,
    volume: price.v || 0,
    vwap: price.vw || 0,
  }));

  prices.sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
  return prices;
}

export async function getPolygonStockSplits(ticker, limit = 10) {
  assertPolygonConfigured();

  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const data = await polygonGetJSON(
    `https://api.polygon.io/v3/reference/splits?ticker=${symbol}&limit=${limit}&apiKey=${POLYGON_API_KEY}`
  );

  return Array.isArray(data?.results)
    ? data.results.map((split) => ({
        executionDate: split.execution_date || '',
        splitFrom: split.split_from || 1,
        splitTo: split.split_to || 1,
      }))
    : [];
}

export async function getPolygonBasicInfo(ticker) {
  const [company, quote] = await Promise.all([
    getPolygonCompanyDetails(ticker),
    getPolygonQuote(ticker),
  ]);

  if (!company || !quote) return null;

  return {
    ticker: company.ticker,
    name: company.name,
    logoUrl: company.logoUrl,
    price: quote.currentPrice,
    change: quote.change,
    changePercent: quote.changePercent,
    sector: company.sector,
    industry: company.industry,
    listDate: company.listDate,
  };
}
