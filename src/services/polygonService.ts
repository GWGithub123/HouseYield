/**
 * Polygon.io API Service
 * Provides real-time stock market data
 */

const POLYGON_API_KEY = import.meta.env.VITE_POLYGON_API_KEY || '';
if (!POLYGON_API_KEY) console.warn('[Polygon] VITE_POLYGON_API_KEY not configured in .env');
const POLYGON_BASE_URL = 'https://api.polygon.io';

export interface StockQuote {
  ticker: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  lastUpdated: string;
}

export interface TickerSearchResult {
  ticker: string;
  name: string;
  market: string;
  locale: string;
  primary_exchange: string;
  type: string;
  active: boolean;
}

/**
 * Search for ticker symbols
 * @param query - Search term (company name or ticker)
 * @returns Array of matching ticker results
 */
export async function searchTickers(query: string): Promise<TickerSearchResult[]> {
  if (!query || query.trim().length === 0) {
    return [];
  }

  try {
    const response = await fetch(
      `${POLYGON_BASE_URL}/v3/reference/tickers?search=${encodeURIComponent(query)}&active=true&limit=10&apiKey=${POLYGON_API_KEY}`
    );

    if (!response.ok) {
      throw new Error(`Failed to search tickers: ${response.statusText}`);
    }

    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('Error searching tickers:', error);
    throw error;
  }
}

/**
 * Get the latest quote for a ticker
 * @param ticker - Stock ticker symbol (e.g., 'AAPL')
 * @returns Stock quote with current price and details
 */
export async function getStockQuote(ticker: string): Promise<StockQuote> {
  if (!ticker) {
    throw new Error('Ticker symbol is required');
  }

  try {
    // Get previous day's close and today's snapshot
    const [prevCloseResponse, snapshotResponse] = await Promise.all([
      fetch(`${POLYGON_BASE_URL}/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${POLYGON_API_KEY}`),
      fetch(`${POLYGON_BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${POLYGON_API_KEY}`)
    ]);

    if (!prevCloseResponse.ok || !snapshotResponse.ok) {
      throw new Error('Failed to fetch stock quote');
    }

    const [prevCloseData, snapshotData] = await Promise.all([
      prevCloseResponse.json(),
      snapshotResponse.json()
    ]);

    const snapshot = snapshotData.ticker;
    const prevClose = prevCloseData.results?.[0];

    // Use the latest available price (in order of preference: min price, prev close, day close)
    const currentPrice = snapshot?.min?.c || snapshot?.prevDay?.c || prevClose?.c || 0;
    const previousClose = snapshot?.prevDay?.c || prevClose?.c || currentPrice;
    
    const change = currentPrice - previousClose;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

    return {
      ticker: ticker.toUpperCase(),
      name: snapshotData.ticker?.name || ticker,
      price: currentPrice,
      change: change,
      changePercent: changePercent,
      lastUpdated: new Date(snapshot?.updated || snapshot?.lastTrade?.t || Date.now()).toISOString()
    };
  } catch (error) {
    console.error(`Error fetching quote for ${ticker}:`, error);
    throw error;
  }
}

/**
 * Get ticker details including company name
 * @param ticker - Stock ticker symbol
 * @returns Ticker details
 */
export async function getTickerDetails(ticker: string): Promise<TickerSearchResult | null> {
  try {
    const response = await fetch(
      `${POLYGON_BASE_URL}/v3/reference/tickers/${ticker}?apiKey=${POLYGON_API_KEY}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch ticker details: ${response.statusText}`);
    }

    const data = await response.json();
    return data.results || null;
  } catch (error) {
    console.error('Error fetching ticker details:', error);
    return null;
  }
}

/**
 * Calculate the total value of a stock position
 * @param price - Price per share
 * @param shares - Number of shares owned
 * @returns Total value of the position
 */
export function calculateStockValue(price: number, shares: number): number {
  return price * shares;
}
