/**
 * Portfolio Service
 * Manages portfolio assets, historical values, and daily market updates
 */

import {
  collection,
  doc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  deleteDoc,
  writeBatch
} from 'firebase/firestore';
import { db } from '../config/firebase';

// ============================================================================
// Types
// ============================================================================

export interface Asset {
  id: string;
  name: string;
  type: 'realEstate' | 'stocks' | 'cash' | 'bonds' | 'alternatives';
  value: number;
  ticker?: string;
  shares?: number;
  pricePerShare?: number;
  costBasis?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Liability {
  id: string;
  name: string;
  type: 'mortgage' | 'auto_loan' | 'student_loan' | 'credit_card' | 'personal_loan' | 'heloc' | 'other';
  balance: number; // Outstanding balance
  originalAmount?: number; // Original loan amount
  interestRate?: number; // Annual interest rate
  monthlyPayment?: number;
  termMonths?: number; // Total loan term in months
  startDate?: string; // Loan origination date
  linkedAssetId?: string; // Link to the property/asset this debt is against
  lenderName?: string;
  isFromATTOM?: boolean; // Whether this was auto-loaded from ATTOM data
  attomPropertyId?: string; // Reference to ATTOM property for auto-updates
  createdAt: string;
  updatedAt: string;
}

export interface PortfolioSnapshot {
  id: string;
  userId: string;
  date: string; // ISO date string
  totalValue: number;
  totalLiabilities?: number;
  netWorth?: number;
  assets: {
    realEstate: number;
    stocks: number;
    cash: number;
    bonds: number;
    alternatives: number;
  };
  liabilities?: {
    mortgage: number;
    auto_loan: number;
    student_loan: number;
    credit_card: number;
    personal_loan: number;
    heloc: number;
    other: number;
  };
  assetBreakdown: Asset[];
  liabilityBreakdown?: Liability[];
  createdAt: string;
}

export interface PortfolioData {
  assets: {
    realEstate: Asset[];
    stocks: Asset[];
    cash: Asset[];
    bonds: Asset[];
    alternatives: Asset[];
  };
  liabilities?: Liability[];
  snapshots: PortfolioSnapshot[];
}

// ============================================================================
// Stock Detail Types
// ============================================================================

export interface StockCompanyDetails {
  ticker: string;
  name: string;
  description: string;
  homepageUrl: string;
  logoUrl: string;
  listDate: string;
  marketCap: number;
  totalEmployees: number;
  primaryExchange: string;
  sector: string;
  industry: string;
  address: {
    address1: string;
    city: string;
    state: string;
    postalCode: string;
  };
  phoneNumber: string;
}

export interface StockQuote {
  ticker: string;
  currentPrice: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  vwap: number;
  change: number;
  changePercent: number;
  fiftyTwoWeekHigh: number;
  fiftyTwoWeekLow: number;
  marketStatus: 'open' | 'closed' | 'extended-hours';
}

export interface StockDividend {
  cashAmount: number;
  declarationDate: string;
  exDividendDate: string;
  payDate: string;
  frequency: number; // 1=annual, 4=quarterly, 12=monthly
  dividendType: string;
}

export interface StockFinancials {
  ticker: string;
  filingDate: string;
  fiscalPeriod: string;
  fiscalYear: string;
  // Income Statement
  revenues: number;
  netIncome: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingIncome: number;
  earningsPerShare: number;
  earningsPerShareDiluted: number;
  // Balance Sheet
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  currentAssets: number;
  currentLiabilities: number;
  cash: number;
  // Cash Flow
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  freeCashFlow: number;
  // Ratios
  peRatio: number;
  priceToBook: number;
  debtToEquity: number;
}

export interface StockNews {
  id: string;
  title: string;
  description: string;
  articleUrl: string;
  imageUrl: string;
  publishedUtc: string;
  publisher: {
    name: string;
    logoUrl: string;
  };
  tickers: string[];
}

export interface StockHistoricalPrice {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
}

export interface StockSplit {
  executionDate: string;
  splitFrom: number;
  splitTo: number;
}

export interface ComprehensiveStockData {
  company: StockCompanyDetails;
  quote: StockQuote;
  dividends: StockDividend[];
  financials: StockFinancials[];
  annualFinancials: StockFinancials[];
  news: StockNews[];
  historicalPrices: StockHistoricalPrice[];
  splits: StockSplit[];
}

// ============================================================================
// Asset Management
// ============================================================================

/**
 * Add a new asset to the portfolio
 */
export async function addAsset(
  userId: string,
  asset: Omit<Asset, 'id' | 'createdAt' | 'updatedAt'>
): Promise<{ success: boolean; asset?: Asset; error?: string }> {
  try {
    const now = new Date().toISOString();
    const assetData: Asset = {
      ...asset,
      id: doc(collection(db, 'portfolios', userId, 'assets')).id,
      createdAt: now,
      updatedAt: now,
    };

    await setDoc(doc(db, 'portfolios', userId, 'assets', assetData.id), assetData);

    // Create a snapshot after adding the asset
    await createPortfolioSnapshot(userId);

    return { success: true, asset: assetData };
  } catch (error: any) {
    console.error('Error adding asset:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Update an existing asset
 */
export async function updateAsset(
  userId: string,
  assetId: string,
  updates: Partial<Omit<Asset, 'id' | 'createdAt'>>
): Promise<{ success: boolean; error?: string }> {
  try {
    const assetRef = doc(db, 'portfolios', userId, 'assets', assetId);
    await updateDoc(assetRef, {
      ...updates,
      updatedAt: new Date().toISOString(),
    });

    // Create a snapshot after updating
    await createPortfolioSnapshot(userId);

    return { success: true };
  } catch (error: any) {
    console.error('Error updating asset:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete an asset
 */
export async function deleteAsset(
  userId: string,
  assetId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await deleteDoc(doc(db, 'portfolios', userId, 'assets', assetId));

    // Create a snapshot after deleting
    await createPortfolioSnapshot(userId);

    return { success: true };
  } catch (error: any) {
    console.error('Error deleting asset:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get all assets for a user
 */
export async function getAssets(userId: string): Promise<PortfolioData['assets']> {
  try {
    const assetsSnapshot = await getDocs(collection(db, 'portfolios', userId, 'assets'));
    const assets: Asset[] = assetsSnapshot.docs.map(doc => doc.data() as Asset);

    // Group by type
    const grouped: PortfolioData['assets'] = {
      realEstate: assets.filter(a => a.type === 'realEstate'),
      stocks: assets.filter(a => a.type === 'stocks'),
      cash: assets.filter(a => a.type === 'cash'),
      bonds: assets.filter(a => a.type === 'bonds'),
      alternatives: assets.filter(a => a.type === 'alternatives'),
    };

    return grouped;
  } catch (error) {
    console.error('Error getting assets:', error);
    return {
      realEstate: [],
      stocks: [],
      cash: [],
      bonds: [],
      alternatives: [],
    };
  }
}

// ============================================================================
// Liability Management
// ============================================================================

/**
 * Add a new liability
 */
export async function addLiability(
  userId: string,
  liability: Omit<Liability, 'id' | 'createdAt' | 'updatedAt'>
): Promise<{ success: boolean; liability?: Liability; error?: string }> {
  try {
    const now = new Date().toISOString();
    const liabilityData: Liability = {
      ...liability,
      id: doc(collection(db, 'portfolios', userId, 'liabilities')).id,
      createdAt: now,
      updatedAt: now,
    };

    await setDoc(doc(db, 'portfolios', userId, 'liabilities', liabilityData.id), liabilityData);

    // Create a snapshot after adding the liability
    await createPortfolioSnapshot(userId);

    return { success: true, liability: liabilityData };
  } catch (error: any) {
    console.error('Error adding liability:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Update an existing liability
 */
export async function updateLiability(
  userId: string,
  liabilityId: string,
  updates: Partial<Omit<Liability, 'id' | 'createdAt'>>
): Promise<{ success: boolean; error?: string }> {
  try {
    const liabilityRef = doc(db, 'portfolios', userId, 'liabilities', liabilityId);
    await updateDoc(liabilityRef, {
      ...updates,
      updatedAt: new Date().toISOString(),
    });

    // Create a snapshot after updating
    await createPortfolioSnapshot(userId);

    return { success: true };
  } catch (error: any) {
    console.error('Error updating liability:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete a liability
 */
export async function deleteLiability(
  userId: string,
  liabilityId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await deleteDoc(doc(db, 'portfolios', userId, 'liabilities', liabilityId));

    // Create a snapshot after deleting
    await createPortfolioSnapshot(userId);

    return { success: true };
  } catch (error: any) {
    console.error('Error deleting liability:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get all liabilities for a user
 */
export async function getLiabilities(userId: string): Promise<Liability[]> {
  try {
    const liabilitiesSnapshot = await getDocs(collection(db, 'portfolios', userId, 'liabilities'));
    const liabilities: Liability[] = liabilitiesSnapshot.docs.map(doc => doc.data() as Liability);
    return liabilities;
  } catch (error) {
    console.error('Error getting liabilities:', error);
    return [];
  }
}

/**
 * Calculate remaining mortgage balance from ATTOM property data
 * Uses the mortgage amortization formula
 */
export function calculateRemainingMortgageBalance(
  originalAmount: number,
  annualRate: number,
  termMonths: number,
  loanDate: string
): { remainingBalance: number; monthsRemaining: number; percentPaid: number } {
  if (!originalAmount || !annualRate || !termMonths || !loanDate) {
    return { remainingBalance: originalAmount || 0, monthsRemaining: termMonths || 0, percentPaid: 0 };
  }

  const monthlyRate = annualRate / 100 / 12;
  const loanStart = new Date(loanDate);
  const now = new Date();
  
  // Calculate months elapsed since loan origination
  const monthsElapsed = Math.floor((now.getTime() - loanStart.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
  
  if (monthsElapsed <= 0) {
    return { remainingBalance: originalAmount, monthsRemaining: termMonths, percentPaid: 0 };
  }

  if (monthsElapsed >= termMonths) {
    return { remainingBalance: 0, monthsRemaining: 0, percentPaid: 100 };
  }

  // Amortization formula for remaining balance
  const onePlusR = 1 + monthlyRate;
  const powerN = Math.pow(onePlusR, termMonths);
  const powerP = Math.pow(onePlusR, monthsElapsed);
  
  const remainingBalance = originalAmount * ((powerN - powerP) / (powerN - 1));
  const monthsRemaining = termMonths - monthsElapsed;
  const principalPaid = originalAmount - remainingBalance;

  return {
    remainingBalance: Math.max(0, remainingBalance),
    monthsRemaining,
    percentPaid: (principalPaid / originalAmount) * 100,
  };
}

// ============================================================================
// Portfolio Snapshots
// ============================================================================

/**
 * Create a portfolio snapshot for the current date
 */
export async function createPortfolioSnapshot(userId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Get all current assets
    const assets = await getAssets(userId);
    const allAssets = [
      ...assets.realEstate,
      ...assets.stocks,
      ...assets.cash,
      ...assets.bonds,
      ...assets.alternatives,
    ];

    // Calculate totals
    const totals = {
      realEstate: assets.realEstate.reduce((sum, a) => sum + a.value, 0),
      stocks: assets.stocks.reduce((sum, a) => sum + a.value, 0),
      cash: assets.cash.reduce((sum, a) => sum + a.value, 0),
      bonds: assets.bonds.reduce((sum, a) => sum + a.value, 0),
      alternatives: assets.alternatives.reduce((sum, a) => sum + a.value, 0),
    };

    const totalValue = Object.values(totals).reduce((sum, val) => sum + val, 0);

    // Use today's date at midnight for consistency
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dateKey = today.toISOString().split('T')[0];

    const snapshot: Omit<PortfolioSnapshot, 'id'> = {
      userId,
      date: dateKey,
      totalValue,
      assets: totals,
      assetBreakdown: allAssets,
      createdAt: new Date().toISOString(),
    };

    // Use date as ID to avoid duplicates on the same day
    await setDoc(doc(db, 'portfolios', userId, 'snapshots', dateKey), snapshot);

    return { success: true };
  } catch (error: any) {
    console.error('Error creating portfolio snapshot:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Create an hourly portfolio snapshot with datetime-granular key.
 * This allows tracking net worth fluctuations throughout the day.
 * Snapshots are keyed by ISO datetime (e.g. "2026-02-24T14:00") to
 * avoid overwriting daily snapshots (keyed by "2026-02-24").
 */
export async function createHourlyPortfolioSnapshot(userId: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Get all current assets
    const assets = await getAssets(userId);
    const allAssets = [
      ...assets.realEstate,
      ...assets.stocks,
      ...assets.cash,
      ...assets.bonds,
      ...assets.alternatives,
    ];

    // Calculate totals
    const totals = {
      realEstate: assets.realEstate.reduce((sum, a) => sum + a.value, 0),
      stocks: assets.stocks.reduce((sum, a) => sum + a.value, 0),
      cash: assets.cash.reduce((sum, a) => sum + a.value, 0),
      bonds: assets.bonds.reduce((sum, a) => sum + a.value, 0),
      alternatives: assets.alternatives.reduce((sum, a) => sum + a.value, 0),
    };

    const totalValue = Object.values(totals).reduce((sum, val) => sum + val, 0);

    // Use current hour (truncated to the hour) as the key for dedup
    const now = new Date();
    const hourKey = now.toISOString().slice(0, 16); // e.g. "2026-02-24T14:00"
    const dateStr = now.toISOString().split('T')[0];

    const snapshot: Omit<PortfolioSnapshot, 'id'> = {
      userId,
      date: hourKey, // ISO datetime so it sorts correctly alongside daily keys
      totalValue,
      assets: totals,
      assetBreakdown: allAssets,
      createdAt: now.toISOString(),
    };

    // Use hourKey as doc ID – one snapshot per hour max
    await setDoc(doc(db, 'portfolios', userId, 'snapshots', hourKey), snapshot);

    console.log(`[Portfolio] Hourly snapshot saved: ${hourKey} — $${totalValue.toLocaleString()}`);
    return { success: true };
  } catch (error: any) {
    console.error('Error creating hourly portfolio snapshot:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Schedule hourly portfolio updates.
 * Runs updateStockPrices + createHourlyPortfolioSnapshot every hour
 * during US market hours (9 AM – 5 PM ET, Mon–Fri).
 * Falls back to every 4 hours outside market hours.
 * Returns a cleanup function to clear the interval.
 */
export function scheduleHourlyUpdate(userId: string): () => void {
  const MARKET_INTERVAL = 60 * 60 * 1000;       // 1 hour
  const OFF_HOURS_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

  const isMarketHours = (): boolean => {
    const now = new Date();
    const day = now.getDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;
    // Approximate ET: UTC-5 (ignoring DST for simplicity)
    const etHour = (now.getUTCHours() - 5 + 24) % 24;
    return etHour >= 9 && etHour < 17;
  };

  let lastRunTime = 0;

  const runUpdate = async () => {
    console.log('[Portfolio] Running hourly price update...');
    const result = await updateStockPrices(userId);
    console.log(`[Portfolio] Updated ${result.updatedCount} stocks. Creating hourly snapshot...`);
    await createHourlyPortfolioSnapshot(userId);
    lastRunTime = Date.now();
  };

  // Run once immediately on start
  runUpdate();

  // Check every hour whether it's time to run again.
  // During market hours → run every 1 h. Off-hours → run every 4 h.
  const intervalId = setInterval(() => {
    const requiredGap = isMarketHours() ? MARKET_INTERVAL : OFF_HOURS_INTERVAL;
    if (Date.now() - lastRunTime >= requiredGap) {
      runUpdate();
    }
  }, MARKET_INTERVAL);

  return () => clearInterval(intervalId);
}

/**
 * Get portfolio snapshots for a date range.
 * Works with both daily keys ("2026-02-24") and hourly keys ("2026-02-24T14:00").
 */
export async function getPortfolioSnapshots(
  userId: string,
  startDate: Date,
  endDate: Date
): Promise<PortfolioSnapshot[]> {
  try {
    const startKey = startDate.toISOString().split('T')[0];
    // Use end-of-day marker so hourly snapshots on the end date are included
    const endKey = endDate.toISOString().split('T')[0] + 'T23:59';

    const q = query(
      collection(db, 'portfolios', userId, 'snapshots'),
      where('date', '>=', startKey),
      where('date', '<=', endKey),
      orderBy('date', 'asc')
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as PortfolioSnapshot));
  } catch (error) {
    console.error('Error getting portfolio snapshots:', error);
    return [];
  }
}

/**
 * Get the most recent portfolio snapshot
 */
export async function getLatestSnapshot(userId: string): Promise<PortfolioSnapshot | null> {
  try {
    const q = query(
      collection(db, 'portfolios', userId, 'snapshots'),
      orderBy('date', 'desc')
    );

    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    return { id: doc.id, ...doc.data() } as PortfolioSnapshot;
  } catch (error) {
    console.error('Error getting latest snapshot:', error);
    return null;
  }
}

// ============================================================================
// Stock Price Updates (via Polygon API)
// ============================================================================

const STOCK_API_BASE = import.meta.env.VITE_API_URL || '';

function normalizeTicker(ticker: string): string {
  return String(ticker || '').trim().toUpperCase();
}

function buildStockApiUrl(path: string): string {
  return STOCK_API_BASE ? `${STOCK_API_BASE}${path}` : path;
}

async function fetchStockApiData<T>(path: string): Promise<T> {
  const response = await fetch(buildStockApiUrl(path));
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return (payload?.data ?? payload) as T;
}

/**
 * Get current stock price from Polygon API
 */
export async function getStockPrice(ticker: string): Promise<number | null> {
  try {
    const quote = await getStockQuote(ticker);
    return quote?.currentPrice ?? null;
  } catch (error) {
    console.error(`Error fetching price for ${ticker}:`, error);
    return null;
  }
}

/**
 * Update all stock prices for a user's portfolio
 */
export async function updateStockPrices(userId: string): Promise<{ success: boolean; updatedCount: number; error?: string }> {
  try {
    const assets = await getAssets(userId);
    const stockAssets = assets.stocks.filter(a => a.ticker);

    let updatedCount = 0;
    const batch = writeBatch(db);

    for (const stock of stockAssets) {
      if (!stock.ticker) continue;

      const currentPrice = await getStockPrice(stock.ticker);
      if (currentPrice !== null && stock.shares) {
        const newValue = currentPrice * stock.shares;
        
        const assetRef = doc(db, 'portfolios', userId, 'assets', stock.id);
        batch.update(assetRef, {
          pricePerShare: currentPrice,
          value: newValue,
          updatedAt: new Date().toISOString(),
        });
        
        updatedCount++;
      }

      // Rate limiting - wait 100ms between requests
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    await batch.commit();

    // Create a new snapshot with updated values
    if (updatedCount > 0) {
      await createPortfolioSnapshot(userId);
    }

    return { success: true, updatedCount };
  } catch (error: any) {
    console.error('Error updating stock prices:', error);
    return { success: false, updatedCount: 0, error: error.message };
  }
}

/**
 * Schedule daily portfolio update at 4PM EST (market close)
 * This should be called when the app loads
 */
export function scheduleDailyUpdate(userId: string): () => void {
  const schedule4PMUpdate = () => {
    const now = new Date();
    const target = new Date();
    
    // Set to 4PM EST (convert to local time)
    // Note: This is simplified - in production, you'd want to handle DST properly
    target.setHours(16, 0, 0, 0);
    
    // If it's past 4PM today, schedule for tomorrow
    if (now >= target) {
      target.setDate(target.getDate() + 1);
    }
    
    const msUntilUpdate = target.getTime() - now.getTime();
    
    console.log(`Next portfolio update scheduled for: ${target.toLocaleString()}`);
    
    return setTimeout(async () => {
      console.log('Running daily portfolio update...');
      const result = await updateStockPrices(userId);
      console.log(`Portfolio update complete. Updated ${result.updatedCount} stocks.`);
      
      // Schedule next update
      const cleanup = schedule4PMUpdate();
      return cleanup;
    }, msUntilUpdate);
  };

  const timerId = schedule4PMUpdate();
  
  // Return cleanup function
  return () => {
    if (timerId) {
      clearTimeout(timerId);
    }
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Calculate date range based on time period selector
 */
export type NetWorthTimePeriod = '1d' | '1w' | '1m' | 'YTD' | '3m' | '6m' | '1y' | '2y' | '3y';

export function getDateRangeForPeriod(period: NetWorthTimePeriod): { startDate: Date; endDate: Date } {
  const endDate = new Date();
  const startDate = new Date();

  switch (period) {
    case '1d':
      startDate.setDate(startDate.getDate() - 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    case '1w':
      startDate.setDate(startDate.getDate() - 7);
      startDate.setHours(0, 0, 0, 0);
      break;
    case '1m':
      startDate.setMonth(startDate.getMonth() - 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'YTD':
      startDate.setMonth(0, 1); // January 1st of current year
      startDate.setHours(0, 0, 0, 0);
      break;
    case '3m':
      startDate.setMonth(startDate.getMonth() - 3);
      break;
    case '6m':
      startDate.setMonth(startDate.getMonth() - 6);
      break;
    case '1y':
      startDate.setFullYear(startDate.getFullYear() - 1);
      break;
    case '2y':
      startDate.setFullYear(startDate.getFullYear() - 2);
      break;
    case '3y':
      startDate.setFullYear(startDate.getFullYear() - 3);
      break;
  }

  return { startDate, endDate };
}

/**
 * Calculate YTD percentage change
 */
export function calculateYTDChange(snapshots: PortfolioSnapshot[]): number {
  if (snapshots.length < 2) return 0;

  const firstSnapshot = snapshots[0];
  const latestSnapshot = snapshots[snapshots.length - 1];

  if (firstSnapshot.totalValue === 0) return 0;

  const change = ((latestSnapshot.totalValue - firstSnapshot.totalValue) / firstSnapshot.totalValue) * 100;
  return change;
}

// ============================================================================
// localStorage Cache Utility (reduces Polygon API calls)
// ============================================================================

const CACHE_PREFIX = 'hy_poly_';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() > entry.expiresAt) {
      localStorage.removeItem(CACHE_PREFIX + key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

function cacheSet<T>(key: string, data: T, ttlMs: number): void {
  try {
    const entry: CacheEntry<T> = { data, expiresAt: Date.now() + ttlMs };
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
  } catch {
    // localStorage full or unavailable — skip silently
  }
}

const TTL_MS = {
  QUOTE:    15 * 60 * 1000,          // 15 minutes  (prices refresh intraday)
  COMPANY:  24 * 60 * 60 * 1000,     // 24 hours    (logos/metadata rarely change)
  DIVIDENDS: 24 * 60 * 60 * 1000,    // 24 hours    (declared at most quarterly)
  SPLITS:    7 * 24 * 60 * 60 * 1000, // 7 days     (splits are very rare)
  HIST_PAST: 7 * 24 * 60 * 60 * 1000, // 7 days     (historical bars are immutable)
  HIST_TODAY: 12 * 60 * 60 * 1000,   // 12 hours   (ranges ending today may extend)
  HIST_DIVIDENDS: 7 * 24 * 60 * 60 * 1000,
  FINANCIALS: 7 * 24 * 60 * 60 * 1000,
  NEWS: 60 * 60 * 1000,
  INCOME_BATCH: 15 * 60 * 1000,
};

interface StockIncomeBatchData {
  basicInfo: Record<string, {
    ticker: string;
    name: string;
    logoUrl: string;
    price: number;
    change: number;
    changePercent: number;
    sector?: string;
    industry?: string;
    listDate?: string;
  }>;
  dividends: Record<string, StockDividend[]>;
  splits: Record<string, StockSplit[]>;
}

// ============================================================================
// Comprehensive Stock Data API Functions
// ============================================================================

/**
 * Get company details including logo, description, sector, etc.
 */
export async function getCompanyDetails(ticker: string): Promise<StockCompanyDetails | null> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;

  const cacheKey = `company_${symbol}`;
  const cached = cacheGet<StockCompanyDetails>(cacheKey);
  if (cached) return cached;

  try {
    const result = await fetchStockApiData<StockCompanyDetails>(
      `/api/stocks/company/${encodeURIComponent(symbol)}`
    );
    cacheSet(cacheKey, result, TTL_MS.COMPANY);
    return result;
  } catch (error) {
    console.error(`Error fetching company details for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get real-time stock quote with day change (uses snapshot for real-time data)
 */
export async function getStockQuote(ticker: string): Promise<StockQuote | null> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;

  const cacheKey = `quote_${symbol}`;
  const cached = cacheGet<StockQuote>(cacheKey);
  if (cached) return cached;

  try {
    const result = await fetchStockApiData<StockQuote>(
      `/api/stocks/quote/${encodeURIComponent(symbol)}`
    );
    cacheSet(cacheKey, result, TTL_MS.QUOTE);
    return result;
  } catch (error) {
    console.error(`Error fetching quote for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get dividend history for a stock
 */
export async function getDividends(ticker: string): Promise<StockDividend[]> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const cacheKey = `div_${symbol}`;
  const cached = cacheGet<StockDividend[]>(cacheKey);
  if (cached) return cached;

  try {
    const result = await fetchStockApiData<StockDividend[]>(
      `/api/stocks/dividends/${encodeURIComponent(symbol)}?limit=20`
    );
    cacheSet(cacheKey, result, TTL_MS.DIVIDENDS);
    return result;
  } catch (error: any) {
    if (typeof error?.message === 'string' && error.message.includes('polygon_rate_limited')) {
      throw new Error(`RATE_LIMIT:${symbol}`);
    }

    console.error(`Error fetching dividends for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get financial statements (income statement, balance sheet, cash flow)
 */
export async function getFinancials(
  ticker: string,
  timeframe: 'quarterly' | 'annual' = 'quarterly',
  limit: number = timeframe === 'quarterly' ? 20 : 5
): Promise<StockFinancials[]> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const cacheKey = `financials_${symbol}_${timeframe}_${limit}`;
  const cached = cacheGet<StockFinancials[]>(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      timeframe,
      limit: String(limit),
    });
    const results = await fetchStockApiData<StockFinancials[]>(
      `/api/stocks/financials/${encodeURIComponent(symbol)}?${params.toString()}`
    );
    cacheSet(cacheKey, results, TTL_MS.FINANCIALS);
    return results;
  } catch (error) {
    console.error(`Error fetching financials for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get recent news articles about a stock
 */
export async function getStockNews(ticker: string): Promise<StockNews[]> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const cacheKey = `news_${symbol}_10`;
  const cached = cacheGet<StockNews[]>(cacheKey);
  if (cached) return cached;

  try {
    const result = await fetchStockApiData<StockNews[]>(
      `/api/stocks/news/${encodeURIComponent(symbol)}?limit=10`
    );
    cacheSet(cacheKey, result, TTL_MS.NEWS);
    return result;
  } catch (error) {
    console.error(`Error fetching news for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get historical price data for charting
 */
export async function getHistoricalPrices(
  ticker: string, 
  from: string, 
  to: string,
  timespan: 'day' | 'week' | 'month' = 'day'
): Promise<StockHistoricalPrice[]> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const today = new Date().toISOString().split('T')[0];
  const ttl = to < today ? TTL_MS.HIST_PAST : TTL_MS.HIST_TODAY;
  const cacheKey = `hist_${symbol}_${from}_${to}_${timespan}`;
  const cached = cacheGet<StockHistoricalPrice[]>(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({ from, to, timespan });
    const prices = await fetchStockApiData<StockHistoricalPrice[]>(
      `/api/stocks/historical-prices/${encodeURIComponent(symbol)}?${params.toString()}`
    );
    cacheSet(cacheKey, prices, ttl);
    return prices;
  } catch (error) {
    console.error(`Error fetching historical prices for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get stock split history
 */
export async function getStockSplits(ticker: string): Promise<StockSplit[]> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const cacheKey = `splits_${symbol}`;
  const cached = cacheGet<StockSplit[]>(cacheKey);
  if (cached) return cached;

  try {
    const result = await fetchStockApiData<StockSplit[]>(
      `/api/stocks/splits/${encodeURIComponent(symbol)}?limit=10`
    );
    cacheSet(cacheKey, result, TTL_MS.SPLITS);
    return result;
  } catch (error) {
    console.error(`Error fetching splits for ${symbol}:`, error);
    return [];
  }
}

export async function getIncomeStockDataBatch(tickers: string[]): Promise<StockIncomeBatchData> {
  const normalizedTickers = Array.from(new Set(tickers.map((ticker) => normalizeTicker(ticker)).filter(Boolean))).sort();

  if (!normalizedTickers.length) {
    return { basicInfo: {}, dividends: {}, splits: {} };
  }

  const cacheKey = `income_batch_${normalizedTickers.join('_')}`;
  const cached = cacheGet<StockIncomeBatchData>(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    tickers: normalizedTickers.join(','),
  });

  const result = await fetchStockApiData<StockIncomeBatchData>(`/api/stocks/income-data?${params.toString()}`);
  cacheSet(cacheKey, result, TTL_MS.INCOME_BATCH);
  return result;
}

/**
 * Get all comprehensive stock data in one call
 */
export async function getComprehensiveStockData(ticker: string): Promise<ComprehensiveStockData | null> {
  try {
    // Calculate date range for historical prices (5 years)
    const to = new Date();
    const from = new Date(to);
    from.setFullYear(from.getFullYear() - 5);
    const toDate = to.toISOString().split('T')[0];
    const fromDate = from.toISOString().split('T')[0];
    
    // Fetch all data in parallel (with rate limiting consideration)
    const [company, quote, dividends, financials, annualFinancials, news, historicalPrices, splits] = await Promise.all([
      getCompanyDetails(ticker),
      getStockQuote(ticker),
      getDividends(ticker),
      getFinancials(ticker, 'quarterly', 20),
      getFinancials(ticker, 'annual', 5),
      getStockNews(ticker),
      getHistoricalPrices(ticker, fromDate, toDate),
      getStockSplits(ticker),
    ]);
    
    if (!company || !quote) return null;
    
    // Calculate P/E ratio now that we have price
    if (financials.length > 0 && financials[0].earningsPerShare > 0) {
      // Use TTM EPS (sum of last 4 quarters)
      const ttmEPS = financials.slice(0, 4).reduce((sum, f) => sum + f.earningsPerShare, 0);
      if (ttmEPS > 0) {
        financials[0].peRatio = quote.currentPrice / ttmEPS;
      }
    }

    if (annualFinancials.length > 0 && annualFinancials[0].earningsPerShare > 0) {
      annualFinancials[0].peRatio = quote.currentPrice / annualFinancials[0].earningsPerShare;
    }
    
    return {
      company,
      quote,
      dividends,
      financials,
      annualFinancials,
      news,
      historicalPrices,
      splits,
    };
  } catch (error) {
    console.error(`Error fetching comprehensive data for ${ticker}:`, error);
    return null;
  }
}

/**
 * Get basic stock info with logo for display in lists
 */
export async function getStockBasicInfo(ticker: string): Promise<{
  ticker: string;
  name: string;
  logoUrl: string;
  price: number;
  change: number;
  changePercent: number;
} | null> {
  try {
    const [company, quote] = await Promise.all([
      getCompanyDetails(ticker),
      getStockQuote(ticker),
    ]);
    
    if (!company || !quote) return null;
    
    return {
      ticker: company.ticker,
      name: company.name,
      logoUrl: company.logoUrl,
      price: quote.currentPrice,
      change: quote.change,
      changePercent: quote.changePercent,
    };
  } catch (error) {
    console.error(`Error fetching basic info for ${ticker}:`, error);
    return null;
  }
}

// ============================================================================
// Index Comparison & Performance Analytics
// ============================================================================

export interface IndexData {
  ticker: string;
  name: string;
  color: string;
  historicalPrices: StockHistoricalPrice[];
}

export interface PerformanceMetrics {
  totalReturn: number; // Percentage return over period
  annualizedReturn: number; // CAGR
  volatility: number; // Standard deviation of returns
  beta: number; // Beta relative to S&P 500
  sharpeRatio: number; // Risk-adjusted return
  maxDrawdown: number; // Maximum peak-to-trough decline
  dividendYield: number; // Annual dividend yield
  appreciationRate: number; // Price appreciation only
}

export interface PortfolioAnalysis {
  portfolioMetrics: PerformanceMetrics;
  indexMetrics: { [key: string]: PerformanceMetrics };
  insights: PortfolioInsight[];
}

export interface PortfolioInsight {
  type: 'advantage' | 'disadvantage' | 'neutral';
  category: 'risk' | 'growth' | 'income' | 'stability';
  title: string;
  description: string;
  recommendation?: string;
}

// Market indices we track
export const MARKET_INDICES = [
  { ticker: 'SPY', name: 'S&P 500', color: '#ef4444' },
  { ticker: 'QQQ', name: 'NASDAQ-100', color: '#22c55e' },
  { ticker: 'DIA', name: 'Dow Jones', color: '#3b82f6' },
] as const;

// Real estate colors for charts
export const REAL_ESTATE_CHART_COLOR = '#f59e0b'; // Amber
export const COMBINED_PORTFOLIO_COLOR = '#8b5cf6'; // Violet

// Dividend return mode types
export type DividendReturnMode = 'price-only' | 'with-dividends' | 'reinvested-dividends';

// Re-export real estate types for convenience
export { 
  type RealEstateReturnMode, 
  type AssetMode, 
  REAL_ESTATE_RETURN_MODES, 
  ASSET_MODES 
} from './realEstatePerformanceService';

export const DIVIDEND_RETURN_MODES = [
  { key: 'price-only', label: 'Price Only', description: 'Returns based on price appreciation only' },
  { key: 'with-dividends', label: 'With Dividends', description: 'Total return including dividend payments' },
  { key: 'reinvested-dividends', label: 'Reinvested Dividends', description: 'Compound return with dividends reinvested' },
] as const;

// Historical dividend data for index ETFs (approximate annual yields by year)
// These are historical average yields for each ETF
export const INDEX_DIVIDEND_YIELDS: { [ticker: string]: { [year: string]: number } } = {
  SPY: { // S&P 500 ETF historical yields
    '2015': 2.0, '2016': 2.1, '2017': 1.8, '2018': 2.0, '2019': 1.8,
    '2020': 1.6, '2021': 1.3, '2022': 1.6, '2023': 1.5, '2024': 1.3, '2025': 1.3, '2026': 1.3
  },
  QQQ: { // NASDAQ-100 ETF historical yields (lower due to tech focus)
    '2015': 1.0, '2016': 1.1, '2017': 0.9, '2018': 0.9, '2019': 0.8,
    '2020': 0.6, '2021': 0.5, '2022': 0.6, '2023': 0.6, '2024': 0.5, '2025': 0.5, '2026': 0.5
  },
  DIA: { // Dow Jones ETF historical yields (higher, more mature companies)
    '2015': 2.3, '2016': 2.4, '2017': 2.1, '2018': 2.3, '2019': 2.1,
    '2020': 2.0, '2021': 1.7, '2022': 1.9, '2023': 1.8, '2024': 1.7, '2025': 1.7, '2026': 1.7
  }
};

/**
 * Get historical dividend data for a ticker within a date range
 */
export async function getHistoricalDividends(
  ticker: string,
  from: string,
  to: string
): Promise<StockDividend[]> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return [];

  const cacheKey = `hist_div_${symbol}_${from}_${to}`;
  const cached = cacheGet<StockDividend[]>(cacheKey);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({ from, to, limit: '100' });
    const result = await fetchStockApiData<StockDividend[]>(
      `/api/stocks/historical-dividends/${encodeURIComponent(symbol)}?${params.toString()}`
    );
    cacheSet(cacheKey, result, TTL_MS.HIST_DIVIDENDS);
    return result;
  } catch (error) {
    console.error(`Error fetching historical dividends for ${symbol}:`, error);
    return [];
  }
}

/**
 * Calculate total return with dividends (simple - dividends added as cash)
 */
export function calculateReturnWithDividends(
  prices: StockHistoricalPrice[],
  dividends: StockDividend[]
): { date: string; value: number; percentChange: number }[] {
  if (prices.length === 0) return [];
  
  const startValue = prices[0].close;
  const result: { date: string; value: number; percentChange: number }[] = [];
  
  // Create a map of ex-dividend dates to amounts
  const dividendMap = new Map<string, number>();
  dividends.forEach(div => {
    if (div.exDividendDate) {
      dividendMap.set(div.exDividendDate, div.cashAmount);
    }
  });
  
  // Track cumulative dividends received
  let cumulativeDividends = 0;
  
  for (const price of prices) {
    // Check if there's a dividend on this date
    const dividend = dividendMap.get(price.date) || 0;
    cumulativeDividends += dividend;
    
    // Total value = current price + all dividends received (per share basis)
    const totalValue = price.close + cumulativeDividends;
    const percentChange = ((totalValue - startValue) / startValue) * 100;
    
    result.push({
      date: price.date,
      value: totalValue,
      percentChange,
    });
  }
  
  return result;
}

/**
 * Calculate compound return with reinvested dividends
 * This simulates reinvesting each dividend payment into more shares
 */
export function calculateCompoundReinvestedReturn(
  prices: StockHistoricalPrice[],
  dividends: StockDividend[]
): { date: string; value: number; percentChange: number }[] {
  if (prices.length === 0) return [];
  
  const startPrice = prices[0].close;
  const result: { date: string; value: number; percentChange: number }[] = [];
  
  // Create a map of ex-dividend dates to amounts
  const dividendMap = new Map<string, number>();
  dividends.forEach(div => {
    if (div.exDividendDate) {
      dividendMap.set(div.exDividendDate, div.cashAmount);
    }
  });
  
  // Start with 1 share, track fractional shares from reinvestment
  let shares = 1;
  
  for (const price of prices) {
    // Check if there's a dividend on this date
    const dividend = dividendMap.get(price.date) || 0;
    
    if (dividend > 0 && price.close > 0) {
      // Calculate dividends received (per share * number of shares)
      const dividendReceived = dividend * shares;
      // Reinvest: buy more fractional shares at current price
      const newShares = dividendReceived / price.close;
      shares += newShares;
    }
    
    // Total value = current price * total shares owned
    const totalValue = price.close * shares;
    const percentChange = ((totalValue - startPrice) / startPrice) * 100;
    
    result.push({
      date: price.date,
      value: totalValue,
      percentChange,
    });
  }
  
  return result;
}

/**
 * Get index data with dividend-adjusted returns
 */
export async function getIndexHistoricalDataWithDividends(
  from: string,
  to: string,
  dividendMode: DividendReturnMode
): Promise<{
  indexData: IndexData[];
  dividendAdjustedReturns: { [ticker: string]: { date: string; percentChange: number }[] };
}> {
  const results: IndexData[] = [];
  const dividendAdjustedReturns: { [ticker: string]: { date: string; percentChange: number }[] } = {};
  
  for (const index of MARKET_INDICES) {
    try {
      const prices = await getHistoricalPrices(index.ticker, from, to, 'day');
      results.push({
        ticker: index.ticker,
        name: index.name,
        color: index.color,
        historicalPrices: prices,
      });
      
      // Rate limiting before fetching dividends
      await new Promise(resolve => setTimeout(resolve, 200));
      
      if (dividendMode !== 'price-only') {
        // Fetch historical dividends for this index
        const dividends = await getHistoricalDividends(index.ticker, from, to);
        
        // Calculate dividend-adjusted returns
        if (dividendMode === 'with-dividends') {
          dividendAdjustedReturns[index.ticker] = calculateReturnWithDividends(prices, dividends);
        } else if (dividendMode === 'reinvested-dividends') {
          dividendAdjustedReturns[index.ticker] = calculateCompoundReinvestedReturn(prices, dividends);
        }
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    } catch (error) {
      console.error(`Error fetching ${index.ticker} data:`, error);
      results.push({
        ticker: index.ticker,
        name: index.name,
        color: index.color,
        historicalPrices: [],
      });
    }
  }
  
  return { indexData: results, dividendAdjustedReturns };
}

/**
 * Get historical data for market indices
 */
export async function getIndexHistoricalData(
  from: string,
  to: string
): Promise<IndexData[]> {
  const results: IndexData[] = [];
  
  for (const index of MARKET_INDICES) {
    try {
      const prices = await getHistoricalPrices(index.ticker, from, to, 'day');
      results.push({
        ticker: index.ticker,
        name: index.name,
        color: index.color,
        historicalPrices: prices,
      });
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error(`Error fetching ${index.ticker} data:`, error);
      results.push({
        ticker: index.ticker,
        name: index.name,
        color: index.color,
        historicalPrices: [],
      });
    }
  }
  
  return results;
}

/**
 * Calculate daily returns from price data
 */
function calculateDailyReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
  }
  return returns;
}

/**
 * Calculate standard deviation
 */
function calculateStdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(avgSquaredDiff);
}

/**
 * Calculate beta relative to a benchmark
 */
function calculateBeta(assetReturns: number[], benchmarkReturns: number[]): number {
  if (assetReturns.length === 0 || benchmarkReturns.length === 0) return 1;
  
  const minLength = Math.min(assetReturns.length, benchmarkReturns.length);
  const assetSlice = assetReturns.slice(0, minLength);
  const benchmarkSlice = benchmarkReturns.slice(0, minLength);
  
  const assetMean = assetSlice.reduce((a, b) => a + b, 0) / minLength;
  const benchmarkMean = benchmarkSlice.reduce((a, b) => a + b, 0) / minLength;
  
  let covariance = 0;
  let benchmarkVariance = 0;
  
  for (let i = 0; i < minLength; i++) {
    const assetDiff = assetSlice[i] - assetMean;
    const benchmarkDiff = benchmarkSlice[i] - benchmarkMean;
    covariance += assetDiff * benchmarkDiff;
    benchmarkVariance += benchmarkDiff * benchmarkDiff;
  }
  
  if (benchmarkVariance === 0) return 1;
  return covariance / benchmarkVariance;
}

/**
 * Calculate maximum drawdown
 */
function calculateMaxDrawdown(values: number[]): number {
  if (values.length === 0) return 0;
  
  let maxValue = values[0];
  let maxDrawdown = 0;
  
  for (const value of values) {
    if (value > maxValue) {
      maxValue = value;
    }
    const drawdown = (maxValue - value) / maxValue;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }
  
  return maxDrawdown * 100;
}

/**
 * Calculate performance metrics for a series of values
 */
export function calculatePerformanceMetrics(
  values: number[],
  benchmarkValues: number[] = [],
  dividendYield: number = 0
): PerformanceMetrics {
  if (values.length < 2) {
    return {
      totalReturn: 0,
      annualizedReturn: 0,
      volatility: 0,
      beta: 1,
      sharpeRatio: 0,
      maxDrawdown: 0,
      dividendYield,
      appreciationRate: 0,
    };
  }
  
  const firstValue = values[0];
  const lastValue = values[values.length - 1];
  
  // Total return
  const totalReturn = firstValue > 0 ? ((lastValue - firstValue) / firstValue) * 100 : 0;
  
  // Annualized return (CAGR)
  const years = values.length / 252; // Approx trading days per year
  const annualizedReturn = years > 0 && firstValue > 0
    ? (Math.pow(lastValue / firstValue, 1 / years) - 1) * 100
    : 0;
  
  // Daily returns for volatility
  const dailyReturns = calculateDailyReturns(values);
  
  // Volatility (annualized standard deviation)
  const dailyVolatility = calculateStdDev(dailyReturns);
  const volatility = dailyVolatility * Math.sqrt(252) * 100;
  
  // Beta (relative to benchmark)
  let beta = 1;
  if (benchmarkValues.length > 0) {
    const benchmarkReturns = calculateDailyReturns(benchmarkValues);
    beta = calculateBeta(dailyReturns, benchmarkReturns);
  }
  
  // Sharpe ratio (assuming risk-free rate of 4%)
  const riskFreeRate = 4;
  const excessReturn = annualizedReturn - riskFreeRate;
  const sharpeRatio = volatility > 0 ? excessReturn / volatility : 0;
  
  // Max drawdown
  const maxDrawdown = calculateMaxDrawdown(values);
  
  // Appreciation rate (same as total return for price-only)
  const appreciationRate = totalReturn;
  
  return {
    totalReturn,
    annualizedReturn,
    volatility,
    beta,
    sharpeRatio,
    maxDrawdown,
    dividendYield,
    appreciationRate,
  };
}

/**
 * Generate portfolio insights based on metrics comparison
 */
export function generatePortfolioInsights(
  portfolioMetrics: PerformanceMetrics,
  spyMetrics: PerformanceMetrics
): PortfolioInsight[] {
  const insights: PortfolioInsight[] = [];
  
  // Compare volatility/beta
  if (portfolioMetrics.beta < 0.8) {
    insights.push({
      type: 'advantage',
      category: 'stability',
      title: 'Lower Market Sensitivity',
      description: `Your portfolio has a beta of ${portfolioMetrics.beta.toFixed(2)}, meaning it moves less than the market. This provides stability during market downturns.`,
      recommendation: 'Great for risk-averse investors seeking capital preservation.',
    });
  } else if (portfolioMetrics.beta > 1.2) {
    insights.push({
      type: 'neutral',
      category: 'risk',
      title: 'Higher Market Sensitivity',
      description: `Your portfolio has a beta of ${portfolioMetrics.beta.toFixed(2)}, amplifying market movements both up and down.`,
      recommendation: 'Consider adding bonds or defensive stocks to reduce volatility if you prefer stability.',
    });
  }
  
  // Compare volatility
  if (portfolioMetrics.volatility < spyMetrics.volatility * 0.8) {
    insights.push({
      type: 'advantage',
      category: 'stability',
      title: 'Lower Volatility',
      description: `Your portfolio volatility of ${portfolioMetrics.volatility.toFixed(1)}% is significantly lower than the S&P 500's ${spyMetrics.volatility.toFixed(1)}%.`,
      recommendation: 'Your portfolio is well-suited for investors who prioritize smooth returns.',
    });
  } else if (portfolioMetrics.volatility > spyMetrics.volatility * 1.3) {
    insights.push({
      type: 'disadvantage',
      category: 'risk',
      title: 'Higher Volatility',
      description: `Your portfolio volatility of ${portfolioMetrics.volatility.toFixed(1)}% exceeds the S&P 500's ${spyMetrics.volatility.toFixed(1)}%.`,
      recommendation: 'Diversification across asset classes could help smooth returns.',
    });
  }
  
  // Compare returns
  if (portfolioMetrics.annualizedReturn > spyMetrics.annualizedReturn + 2) {
    insights.push({
      type: 'advantage',
      category: 'growth',
      title: 'Outperforming the Market',
      description: `Your annualized return of ${portfolioMetrics.annualizedReturn.toFixed(1)}% beats the S&P 500's ${spyMetrics.annualizedReturn.toFixed(1)}%.`,
      recommendation: 'Your growth-oriented strategy is working well. Stay diversified to manage risk.',
    });
  } else if (portfolioMetrics.annualizedReturn < spyMetrics.annualizedReturn - 3) {
    insights.push({
      type: 'disadvantage',
      category: 'growth',
      title: 'Underperforming the Market',
      description: `Your annualized return of ${portfolioMetrics.annualizedReturn.toFixed(1)}% trails the S&P 500's ${spyMetrics.annualizedReturn.toFixed(1)}%.`,
      recommendation: 'Consider whether your allocation aligns with your growth goals.',
    });
  }
  
  // Check dividend yield
  if (portfolioMetrics.dividendYield > 3) {
    insights.push({
      type: 'advantage',
      category: 'income',
      title: 'Strong Income Generation',
      description: `Your portfolio yields ${portfolioMetrics.dividendYield.toFixed(1)}% in dividends annually, providing steady income.`,
      recommendation: 'Excellent for investors seeking passive income or approaching retirement.',
    });
  } else if (portfolioMetrics.dividendYield < 1) {
    insights.push({
      type: 'neutral',
      category: 'income',
      title: 'Growth-Focused Allocation',
      description: `Your dividend yield of ${portfolioMetrics.dividendYield.toFixed(1)}% indicates a focus on growth over income.`,
      recommendation: 'Consider adding dividend stocks if you need more passive income.',
    });
  }
  
  // Check Sharpe ratio
  if (portfolioMetrics.sharpeRatio > 1) {
    insights.push({
      type: 'advantage',
      category: 'risk',
      title: 'Excellent Risk-Adjusted Returns',
      description: `Your Sharpe ratio of ${portfolioMetrics.sharpeRatio.toFixed(2)} indicates strong returns relative to risk taken.`,
      recommendation: 'Your portfolio is efficiently balancing risk and reward.',
    });
  } else if (portfolioMetrics.sharpeRatio < 0.3) {
    insights.push({
      type: 'disadvantage',
      category: 'risk',
      title: 'Low Risk-Adjusted Returns',
      description: `Your Sharpe ratio of ${portfolioMetrics.sharpeRatio.toFixed(2)} suggests returns may not justify the risk.`,
      recommendation: 'Consider rebalancing to improve risk-adjusted performance.',
    });
  }
  
  // Check max drawdown
  if (portfolioMetrics.maxDrawdown < spyMetrics.maxDrawdown * 0.7) {
    insights.push({
      type: 'advantage',
      category: 'stability',
      title: 'Downside Protection',
      description: `Your maximum drawdown of ${portfolioMetrics.maxDrawdown.toFixed(1)}% is lower than the market's ${spyMetrics.maxDrawdown.toFixed(1)}%.`,
      recommendation: 'Your portfolio handles market stress well.',
    });
  } else if (portfolioMetrics.maxDrawdown > spyMetrics.maxDrawdown * 1.3) {
    insights.push({
      type: 'disadvantage',
      category: 'risk',
      title: 'Higher Drawdown Risk',
      description: `Your maximum drawdown of ${portfolioMetrics.maxDrawdown.toFixed(1)}% exceeds the market's ${spyMetrics.maxDrawdown.toFixed(1)}%.`,
      recommendation: 'Consider adding defensive positions to limit downside risk.',
    });
  }
  
  return insights;
}

/**
 * Normalize price series to percentage change from start (for chart comparison)
 */
export function normalizePriceData(
  prices: { date: string; value: number }[]
): { date: string; percentChange: number }[] {
  if (prices.length === 0) return [];
  
  const firstValue = prices[0].value;
  if (firstValue === 0) return prices.map(p => ({ date: p.date, percentChange: 0 }));
  
  return prices.map(p => ({
    date: p.date,
    percentChange: ((p.value - firstValue) / firstValue) * 100,
  }));
}

// ============================================================================
// Weighted Portfolio Historical Performance
// ============================================================================

export interface PortfolioHolding {
  ticker: string;
  name: string;
  weight: number; // Percentage as decimal (e.g., 0.25 for 25%)
  shares?: number;
  value?: number;
}

export interface WeightedHistoricalData {
  dates: string[];
  portfolioValues: number[]; // Normalized to 100 at start
  portfolioReturns: { date: string; percentChange: number }[];
}

/**
 * Calculate weighted historical performance of a portfolio based on current holdings
 * @param holdings - Array of holdings with tickers and weights
 * @param periodMonths - Number of months to look back (e.g., 12 for 1 year)
 */
export async function getWeightedPortfolioHistory(
  holdings: PortfolioHolding[],
  periodMonths: number = 12
): Promise<WeightedHistoricalData | null> {
  if (holdings.length === 0) return null;
  
  try {
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - periodMonths);
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    // Fetch historical data for all holdings in parallel
    const historicalDataPromises = holdings.map(async (holding) => {
      try {
        const prices = await getHistoricalPrices(holding.ticker, startDateStr, endDateStr, 'day');
        return { ticker: holding.ticker, weight: holding.weight, prices };
      } catch (error) {
        console.error(`Error fetching history for ${holding.ticker}:`, error);
        return { ticker: holding.ticker, weight: holding.weight, prices: [] };
      }
    });
    
    const allHistoricalData = await Promise.all(historicalDataPromises);
    
    // Filter out holdings with no data
    const validData = allHistoricalData.filter(d => d.prices.length > 0);
    if (validData.length === 0) return null;
    
    // Find common dates across all holdings
    const dateSets = validData.map(d => new Set(d.prices.map(p => p.date)));
    let commonDates = [...dateSets[0]];
    for (let i = 1; i < dateSets.length; i++) {
      commonDates = commonDates.filter(date => dateSets[i].has(date));
    }
    commonDates.sort();
    
    if (commonDates.length === 0) return null;
    
    // Create price lookup maps for each holding
    const priceMaps = validData.map(d => {
      const map = new Map<string, number>();
      d.prices.forEach(p => map.set(p.date, p.close));
      return { ticker: d.ticker, weight: d.weight, priceMap: map };
    });
    
    // Calculate weighted portfolio value for each date
    // Normalize each stock's price to 1 at start, then weight
    const firstDatePrices = priceMaps.map(pm => pm.priceMap.get(commonDates[0]) || 1);
    
    const portfolioValues: number[] = [];
    const portfolioReturns: { date: string; percentChange: number }[] = [];
    
    for (const date of commonDates) {
      let weightedValue = 0;
      
      for (let i = 0; i < priceMaps.length; i++) {
        const currentPrice = priceMaps[i].priceMap.get(date) || firstDatePrices[i];
        const normalizedPrice = currentPrice / firstDatePrices[i]; // Normalize to 1 at start
        weightedValue += normalizedPrice * priceMaps[i].weight;
      }
      
      // Scale to 100 for easier reading
      portfolioValues.push(weightedValue * 100);
      
      // Calculate percentage change from start
      const percentChange = (weightedValue - 1) * 100;
      portfolioReturns.push({ date, percentChange });
    }
    
    return {
      dates: commonDates,
      portfolioValues,
      portfolioReturns,
    };
  } catch (error) {
    console.error('Error calculating weighted portfolio history:', error);
    return null;
  }
}

/**
 * Calculate weighted historical performance of a portfolio with dividend adjustments
 * @param holdings - Array of holdings with tickers and weights
 * @param periodMonths - Number of months to look back
 * @param dividendMode - How to handle dividends in returns
 */
export async function getWeightedPortfolioHistoryWithDividends(
  holdings: PortfolioHolding[],
  periodMonths: number = 12,
  dividendMode: DividendReturnMode = 'price-only'
): Promise<WeightedHistoricalData | null> {
  if (holdings.length === 0) return null;
  
  // If price-only, use the simpler calculation
  if (dividendMode === 'price-only') {
    return getWeightedPortfolioHistory(holdings, periodMonths);
  }
  
  try {
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - periodMonths);
    
    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];
    
    // Fetch historical price and dividend data for all holdings
    const historicalDataPromises = holdings.map(async (holding) => {
      try {
        const [prices, dividends] = await Promise.all([
          getHistoricalPrices(holding.ticker, startDateStr, endDateStr, 'day'),
          getHistoricalDividends(holding.ticker, startDateStr, endDateStr),
        ]);
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        return { ticker: holding.ticker, weight: holding.weight, prices, dividends };
      } catch (error) {
        console.error(`Error fetching history for ${holding.ticker}:`, error);
        return { ticker: holding.ticker, weight: holding.weight, prices: [], dividends: [] };
      }
    });
    
    const allHistoricalData = await Promise.all(historicalDataPromises);
    
    // Filter out holdings with no price data
    const validData = allHistoricalData.filter(d => d.prices.length > 0);
    if (validData.length === 0) return null;
    
    // Find common dates across all holdings
    const dateSets = validData.map(d => new Set(d.prices.map(p => p.date)));
    let commonDates = [...dateSets[0]];
    for (let i = 1; i < dateSets.length; i++) {
      commonDates = commonDates.filter(date => dateSets[i].has(date));
    }
    commonDates.sort();
    
    if (commonDates.length === 0) return null;
    
    // For each holding, calculate dividend-adjusted values
    const holdingData = validData.map(d => {
      let adjustedData: { date: string; value: number; percentChange: number }[];
      
      if (dividendMode === 'with-dividends') {
        adjustedData = calculateReturnWithDividends(d.prices, d.dividends);
      } else { // 'reinvested-dividends'
        adjustedData = calculateCompoundReinvestedReturn(d.prices, d.dividends);
      }
      
      // Create lookup map
      const valueMap = new Map<string, number>();
      adjustedData.forEach(a => valueMap.set(a.date, a.value));
      
      // Get starting value
      const startValue = adjustedData.find(a => a.date === commonDates[0])?.value || d.prices[0]?.close || 1;
      
      return { ticker: d.ticker, weight: d.weight, valueMap, startValue };
    });
    
    const portfolioValues: number[] = [];
    const portfolioReturns: { date: string; percentChange: number }[] = [];
    
    for (const date of commonDates) {
      let weightedValue = 0;
      
      for (const holding of holdingData) {
        const currentValue = holding.valueMap.get(date) || holding.startValue;
        const normalizedValue = currentValue / holding.startValue; // Normalize to 1 at start
        weightedValue += normalizedValue * holding.weight;
      }
      
      // Scale to 100 for easier reading
      portfolioValues.push(weightedValue * 100);
      
      // Calculate percentage change from start
      const percentChange = (weightedValue - 1) * 100;
      portfolioReturns.push({ date, percentChange });
    }
    
    return {
      dates: commonDates,
      portfolioValues,
      portfolioReturns,
    };
  } catch (error) {
    console.error('Error calculating weighted portfolio history with dividends:', error);
    return null;
  }
}

/**
 * Get the time period configuration for comparison charts
 */
export const COMPARISON_TIME_PERIODS = [
  { label: '3M', months: 3, key: '3m' },
  { label: '6M', months: 6, key: '6m' },
  { label: '1Y', months: 12, key: '1y' },
  { label: '3Y', months: 36, key: '3y' },
  { label: '5Y', months: 60, key: '5y' },
  { label: '10Y', months: 120, key: '10y' },
  { label: 'All', months: 240, key: 'all' }, // 20 years max
] as const;

export type ComparisonTimePeriod = typeof COMPARISON_TIME_PERIODS[number]['key'];

/**
 * Get date range for comparison time period
 */
export function getComparisonDateRange(period: ComparisonTimePeriod): { startDate: string; endDate: string } {
  const config = COMPARISON_TIME_PERIODS.find(p => p.key === period);
  const months = config?.months || 12;
  
  const endDate = new Date();
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  
  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
  };
}

// ============================================================================
// Market Downturn Simulator
// ============================================================================

export interface MarketCrisis {
  id: string;
  name: string;
  description: string;
  startDate: string;
  endDate: string;
  peakToTrough: number; // S&P 500 decline percentage
  recoveryDate?: string;
  sectors: {
    [sector: string]: number; // Sector-specific decline percentages
  };
}

export const MARKET_CRISES: MarketCrisis[] = [
  {
    id: 'dot-com',
    name: 'Dot-Com Bubble',
    description: 'The burst of the technology stock bubble',
    startDate: '2000-03-10',
    endDate: '2002-10-09',
    peakToTrough: -49.1,
    recoveryDate: '2007-05-30',
    sectors: {
      'technology': -78.0,
      'communication-services': -65.0,
      'consumer-discretionary': -35.0,
      'financials': -25.0,
      'healthcare': -20.0,
      'industrials': -30.0,
      'consumer-staples': -10.0,
      'utilities': -5.0,
      'energy': -15.0,
      'materials': -25.0,
      'real-estate': -15.0,
    }
  },
  {
    id: 'gfc-2008',
    name: '2008 Financial Crisis',
    description: 'Global financial crisis triggered by the housing market collapse',
    startDate: '2007-10-09',
    endDate: '2009-03-09',
    peakToTrough: -56.8,
    recoveryDate: '2013-03-28',
    sectors: {
      'financials': -83.0,
      'real-estate': -70.0,
      'consumer-discretionary': -55.0,
      'industrials': -55.0,
      'materials': -50.0,
      'technology': -45.0,
      'energy': -45.0,
      'communication-services': -40.0,
      'healthcare': -35.0,
      'consumer-staples': -25.0,
      'utilities': -30.0,
    }
  },
  {
    id: 'covid-2020',
    name: 'COVID-19 Crash',
    description: 'Rapid market decline due to pandemic uncertainty',
    startDate: '2020-02-19',
    endDate: '2020-03-23',
    peakToTrough: -33.9,
    recoveryDate: '2020-08-18',
    sectors: {
      'energy': -60.0,
      'real-estate': -40.0,
      'financials': -40.0,
      'industrials': -38.0,
      'consumer-discretionary': -35.0,
      'materials': -30.0,
      'communication-services': -25.0,
      'technology': -25.0,
      'healthcare': -20.0,
      'utilities': -22.0,
      'consumer-staples': -15.0,
    }
  },
  {
    id: 'inflation-2022',
    name: '2022 Inflation Bear Market',
    description: 'Market decline due to rising inflation and interest rates',
    startDate: '2022-01-03',
    endDate: '2022-10-12',
    peakToTrough: -25.4,
    sectors: {
      'technology': -35.0,
      'communication-services': -40.0,
      'consumer-discretionary': -35.0,
      'real-estate': -30.0,
      'financials': -20.0,
      'industrials': -18.0,
      'materials': -15.0,
      'healthcare': -10.0,
      'utilities': -5.0,
      'consumer-staples': -8.0,
      'energy': 45.0, // Energy actually went up during this period
    }
  },
  {
    id: 'black-monday-1987',
    name: 'Black Monday 1987',
    description: 'Single-day crash on October 19, 1987',
    startDate: '1987-08-25',
    endDate: '1987-12-04',
    peakToTrough: -33.5,
    recoveryDate: '1989-07-26',
    sectors: {
      'financials': -40.0,
      'technology': -35.0,
      'industrials': -35.0,
      'consumer-discretionary': -35.0,
      'materials': -30.0,
      'energy': -30.0,
      'utilities': -25.0,
      'healthcare': -25.0,
      'consumer-staples': -20.0,
      'communication-services': -30.0,
      'real-estate': -35.0,
    }
  }
];

// Sector mapping for stock classification
export const SECTOR_KEYWORDS: { [sector: string]: string[] } = {
  'technology': ['technology', 'software', 'semiconductor', 'computer', 'internet', 'cloud', 'ai', 'tech'],
  'communication-services': ['communication', 'media', 'entertainment', 'telecom', 'social media'],
  'consumer-discretionary': ['retail', 'automotive', 'restaurant', 'hotel', 'leisure', 'apparel'],
  'consumer-staples': ['food', 'beverage', 'household', 'tobacco', 'grocery'],
  'energy': ['oil', 'gas', 'petroleum', 'energy', 'solar', 'wind'],
  'financials': ['bank', 'insurance', 'investment', 'financial', 'capital', 'asset management'],
  'healthcare': ['pharmaceutical', 'biotech', 'medical', 'healthcare', 'drug', 'hospital'],
  'industrials': ['manufacturing', 'aerospace', 'defense', 'machinery', 'construction', 'transportation'],
  'materials': ['mining', 'chemical', 'metals', 'paper', 'forestry', 'materials'],
  'real-estate': ['reit', 'real estate', 'property'],
  'utilities': ['electric', 'water', 'gas utility', 'utility'],
};

/**
 * Classify a stock into a sector based on its industry/sector info
 */
export function classifyStockSector(sector?: string, industry?: string): string {
  if (!sector && !industry) return 'technology'; // Default
  
  const searchText = `${sector || ''} ${industry || ''}`.toLowerCase();
  
  for (const [sectorKey, keywords] of Object.entries(SECTOR_KEYWORDS)) {
    if (keywords.some(keyword => searchText.includes(keyword))) {
      return sectorKey;
    }
  }
  
  return 'technology'; // Default fallback
}

/**
 * Estimate stock performance during a historical crisis based on sector and beta
 */
export function estimateCrisisPerformance(
  stockSector: string,
  stockBeta: number,
  crisis: MarketCrisis
): number {
  // Get sector-specific decline, or use market average
  const sectorDecline = crisis.sectors[stockSector] ?? crisis.peakToTrough;
  
  // Adjust by beta (higher beta = more decline)
  // If beta > 1, multiply the decline
  // If beta < 1, reduce the decline proportionally
  const betaAdjusted = sectorDecline * stockBeta;
  
  // Clamp to reasonable bounds (-95% to +100%)
  return Math.max(-95, Math.min(100, betaAdjusted));
}

/**
 * Simulate portfolio performance during a market crisis
 */
export async function simulateCrisisPerformance(
  holdings: PortfolioHolding[],
  crisisId: string,
  stockDetails: { [ticker: string]: { sector?: string; industry?: string; beta?: number } }
): Promise<{
  portfolioDecline: number;
  holdingPerformances: { ticker: string; weight: number; decline: number; sector: string }[];
  crisis: MarketCrisis;
  vsMarket: number; // How much better/worse than S&P
} | null> {
  const crisis = MARKET_CRISES.find(c => c.id === crisisId);
  if (!crisis || holdings.length === 0) return null;
  
  const holdingPerformances: { ticker: string; weight: number; decline: number; sector: string }[] = [];
  let totalWeightedDecline = 0;
  
  for (const holding of holdings) {
    const details = stockDetails[holding.ticker] || {};
    const sector = classifyStockSector(details.sector, details.industry);
    const beta = details.beta ?? 1.0;
    
    const decline = estimateCrisisPerformance(sector, beta, crisis);
    
    holdingPerformances.push({
      ticker: holding.ticker,
      weight: holding.weight,
      decline,
      sector,
    });
    
    totalWeightedDecline += decline * holding.weight;
  }
  
  return {
    portfolioDecline: totalWeightedDecline,
    holdingPerformances,
    crisis,
    vsMarket: totalWeightedDecline - crisis.peakToTrough,
  };
}

/**
 * Crisis date range options (centered on the crisis)
 */
export const CRISIS_DATE_RANGES = [
  { label: 'Crisis Period', key: 'crisis', months: 0 }, // Use exact crisis dates
  { label: '±6 Months', key: '6m', months: 6 },
  { label: '±1 Year', key: '1y', months: 12 },
  { label: '±2 Years', key: '2y', months: 24 },
  { label: '±5 Years', key: '5y', months: 60 },
] as const;

export type CrisisDateRange = typeof CRISIS_DATE_RANGES[number]['key'];

/**
 * Get the date range for a crisis with optional expansion
 */
export function getCrisisDateRangeExpanded(
  crisisId: string, 
  rangeKey: CrisisDateRange
): { startDate: string; endDate: string; crisis: MarketCrisis } | null {
  const crisis = MARKET_CRISES.find(c => c.id === crisisId);
  if (!crisis) return null;
  
  const range = CRISIS_DATE_RANGES.find(r => r.key === rangeKey);
  const months = range?.months || 0;
  
  if (months === 0) {
    // Use exact crisis dates
    return {
      startDate: crisis.startDate,
      endDate: crisis.endDate,
      crisis,
    };
  }
  
  // Calculate midpoint of crisis
  const crisisStart = new Date(crisis.startDate);
  const crisisEnd = new Date(crisis.endDate);
  const midpoint = new Date((crisisStart.getTime() + crisisEnd.getTime()) / 2);
  
  // Expand from midpoint
  const startDate = new Date(midpoint);
  startDate.setMonth(startDate.getMonth() - months);
  
  const endDate = new Date(midpoint);
  endDate.setMonth(endDate.getMonth() + months);
  
  // Don't go beyond today
  const today = new Date();
  if (endDate > today) {
    endDate.setTime(today.getTime());
  }
  
  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
    crisis,
  };
}

/**
 * Get actual historical crisis data for comparison chart with date range
 */
export async function getCrisisHistoricalData(
  crisisId: string,
  rangeKey: CrisisDateRange = 'crisis'
): Promise<{ indices: IndexData[]; crisis: MarketCrisis; startDate: string; endDate: string } | null> {
  const dateRange = getCrisisDateRangeExpanded(crisisId, rangeKey);
  if (!dateRange) return null;
  
  try {
    const indices = await getIndexHistoricalData(dateRange.startDate, dateRange.endDate);
    return {
      indices,
      crisis: dateRange.crisis,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
    };
  } catch (error) {
    console.error('Error fetching crisis data:', error);
    return null;
  }
}

/**
 * Simulate portfolio historical performance during a crisis period
 * For stocks that existed, use actual prices
 * For stocks that didn't exist, estimate based on sector and beta
 */
export async function getPortfolioCrisisHistory(
  holdings: PortfolioHolding[],
  crisisId: string,
  rangeKey: CrisisDateRange,
  stockDetails: { [ticker: string]: { sector?: string; industry?: string; beta?: number; listDate?: string } }
): Promise<{
  dates: string[];
  portfolioValues: number[];
  actualHoldings: string[];
  estimatedHoldings: string[];
} | null> {
  const dateRange = getCrisisDateRangeExpanded(crisisId, rangeKey);
  if (!dateRange || holdings.length === 0) return null;
  
  const { startDate, endDate, crisis } = dateRange;
  
  // Separate holdings into those with actual data vs estimated
  const actualHoldings: string[] = [];
  const estimatedHoldings: string[] = [];
  
  // Fetch historical data for all holdings
  const holdingDataPromises = holdings.map(async (holding) => {
    const details = stockDetails[holding.ticker] || {};
    const listDate = details.listDate;
    
    // Check if stock existed before the crisis start
    if (listDate && new Date(listDate) > new Date(startDate)) {
      // Stock didn't exist, needs estimation
      estimatedHoldings.push(holding.ticker);
      return {
        ticker: holding.ticker,
        weight: holding.weight,
        prices: null,
        needsEstimation: true,
        sector: details.sector || 'technology',
        beta: details.beta || 1.0,
      };
    }
    
    try {
      const prices = await getHistoricalPrices(holding.ticker, startDate, endDate, 'day');
      if (prices.length > 0) {
        actualHoldings.push(holding.ticker);
        return {
          ticker: holding.ticker,
          weight: holding.weight,
          prices,
          needsEstimation: false,
          sector: details.sector,
          beta: details.beta,
        };
      } else {
        // No data available, estimate
        estimatedHoldings.push(holding.ticker);
        return {
          ticker: holding.ticker,
          weight: holding.weight,
          prices: null,
          needsEstimation: true,
          sector: details.sector || 'technology',
          beta: details.beta || 1.0,
        };
      }
    } catch {
      estimatedHoldings.push(holding.ticker);
      return {
        ticker: holding.ticker,
        weight: holding.weight,
        prices: null,
        needsEstimation: true,
        sector: details.sector || 'technology',
        beta: details.beta || 1.0,
      };
    }
  });
  
  const holdingData = await Promise.all(holdingDataPromises);
  
  // Get SPY data as baseline for dates and estimation
  const spyData = await getHistoricalPrices('SPY', startDate, endDate, 'day');
  if (spyData.length === 0) return null;
  
  const dates = spyData.map(p => p.date);
  const spyFirstPrice = spyData[0].close;
  
  // Calculate portfolio value for each date
  const portfolioValues: number[] = [];
  
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    let weightedValue = 0;
    
    for (const holding of holdingData) {
      if (holding.needsEstimation || !holding.prices) {
        // Estimate based on sector performance during crisis and beta
        const sectorDecline = crisis.sectors[holding.sector || 'technology'] || crisis.peakToTrough;
        const beta = holding.beta || 1.0;
        
        // Calculate how far through the crisis we are (0 to 1)
        const crisisStartTime = new Date(crisis.startDate).getTime();
        const crisisEndTime = new Date(crisis.endDate).getTime();
        const currentTime = new Date(date).getTime();
        
        let progress = 0;
        if (currentTime <= crisisStartTime) {
          progress = 0;
        } else if (currentTime >= crisisEndTime) {
          progress = 1;
        } else {
          progress = (currentTime - crisisStartTime) / (crisisEndTime - crisisStartTime);
        }
        
        // Apply sector decline adjusted by beta
        // Use a sine curve for more realistic drawdown pattern
        const declineProgress = Math.sin(progress * Math.PI);
        const estimatedDecline = (sectorDecline * beta / 100) * declineProgress;
        const normalizedValue = 1 + estimatedDecline;
        
        weightedValue += normalizedValue * holding.weight;
      } else {
        // Use actual price data
        const priceData = holding.prices.find(p => p.date === date);
        if (priceData) {
          const firstPrice = holding.prices[0].close;
          const normalizedValue = priceData.close / firstPrice;
          weightedValue += normalizedValue * holding.weight;
        } else {
          // Interpolate or use weight
          weightedValue += holding.weight;
        }
      }
    }
    
    portfolioValues.push(weightedValue * 100);
  }
  
  return {
    dates,
    portfolioValues,
    actualHoldings,
    estimatedHoldings,
  };
}
