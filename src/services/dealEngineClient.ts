/**
 * dealEngineClient — typed client for the /api/v2 Deal Analysis Engine.
 */

export interface ScreenResult {
  score: number;
  passes: boolean;
  failReasons: string[];
  dataMissing: boolean;
  valuationEdgePct: number | null;
  estRent: number | null;
  estRentSource?: string | null;
  estPiti: number | null;
  estMonthlyCashFlow: number | null;
  estMonthlyNoi?: number | null;
  estMonthlyOperatingExpenses?: number | null;
  estCashIn?: number | null;
  estCocPct?: number | null;
  estDscr?: number | null;
  estCapRatePct?: number | null;
  breakEvenRent?: number | null;
  cashFlowStatus?: 'positive' | 'near_break_even' | 'negative' | 'unknown';
  positiveCashFlow?: boolean;
  grossYieldPct: number | null;
  priceToRent: number | null;
  domSignal: 'stale' | 'fresh' | 'normal' | null;
  zipMedianPricePerSqft: number | null;
  zipMedianRent: number | null;
  zipGrossYieldPct: number | null;
}

export interface ScreenedListing {
  id: string | null;
  formattedAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  latitude: number | null;
  longitude: number | null;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFootage: number | null;
  yearBuilt: number | null;
  price: number | null;
  daysOnMarket: number | null;
  pricePerSqft: number | null;
  screen: ScreenResult;
}

export interface ScreenerCriteria {
  city?: string;
  state?: string;
  zipCode?: string;
  latitude?: number;
  longitude?: number;
  radiusMiles?: number;
  minPrice?: number;
  maxPrice?: number;
  minBeds?: number;
  maxBeds?: number;
  minBaths?: number;
  maxBaths?: number;
  propertyType?: string;
  limit?: number;
  buyBox?: BuyBox;
  assumptions?: ScreenerAssumptions;
}

export interface BuyBox {
  minMonthlyCashFlow?: number;
  minCocPct?: number;
  minDscr?: number;
  maxPriceToRent?: number;
  minValuationEdgePct?: number;
}

export interface ScreenerAssumptions {
  useLoan?: boolean;
  downPaymentPercent?: number;
  interestRate?: number;
  loanTermYears?: number;
  closingCostPercent?: number;
  propertyTaxPercent?: number;
  insurancePercent?: number;
  maintenancePercent?: number;
  otherCostsPercent?: number;
  vacancyRate?: number;
  managementFee?: number;
}

export interface ScreenerResponse {
  ok: boolean;
  search: any;
  fromCache: boolean;
  mortgageRate: number;
  assumptions?: ScreenerAssumptions;
  funnel: { totalListings: number; screened: number; positiveCashFlow?: number; nearBreakEven?: number; passing: number };
  buyBox: BuyBox;
  listings: ScreenedListing[];
  coverageKey?: string;
}

export interface ScenarioSummary {
  cashIn: number | null;
  loanAmount: number | null;
  downPayment: number | null;
  monthlyMortgagePayment: number | null;
  cashLeftInDeal: number | null;
  refiCashOut: number | null;
  monthlyCashFlowYear1: number | null;
  postRefiMonthlyCashFlow: number | null;
  noiYear1: number | null;
  monthlyDebtServiceYear1: number | null;
  annualDebtServiceYear1: number | null;
  operatingExpensesYear1: number | null;
  grossPotentialIncomeYear1: number | null;
  capRatePct: number | null;
  cocYear1Pct: number | null;
  postRefiCocPct: number | string | null;
  dscrYear1: number | null;
  breakEvenOccupancyPct: number | null;
  grm: number | null;
  irr5yrPct: number | null;
  irr10yrPct: number | null;
  irrAtHoldPct: number | null;
  equityAtHold: number | null;
  totalProfitWhenSold: number | null;
}

export interface DealScenario {
  key: 'buyHold' | 'renovateHold' | 'brrrr';
  label: string;
  description: string;
  summary: ScenarioSummary;
  chartData: any;
  refiEvent: any;
  financing: any;
  holdingRows: any[];
}

export interface RenovationProject {
  name: string;
  area: string;
  cost: number;
  valueUplift: number;
  rentUpliftMonthly: number;
  roiPct: number | null;
  description: string;
}

export interface DealReportData {
  version: number;
  generatedAt: string;
  address: string;
  subject: any;
  sources: any;
  confidence: 'high' | 'medium' | 'low';
  dealScore: {
    score: number;
    grade: string;
    signals: string[];
    headline: string;
    parts: Array<{ key: string; weight: number; points: number; detail: string }>;
  };
  valuation: any;
  rent: any;
  pricingPower: any;
  renovation: {
    conditionGrade: string | null;
    conditionScore: number | null;
    conditionNotes: string;
    projects: RenovationProject[];
    totals: { cost: number; valueUplift: number; rentUpliftMonthly: number };
    arv: number | null;
    photosAnalyzed: number;
    source: string;
  } | null;
  operating: any;
  assumptions: any;
  scenarios: DealScenario[];
  refiGrid: any;
  stressTest: any;
  offerSolver: any;
  marketContext: any;
  environmental: { combinedRiskScore: number | null; hazards: Record<string, number> | null; noiseLevelDb: number | null; source: string } | null;
  avmHistory: any;
  priceHistory: any;
  taxHistory: any;
}

export interface CoverageArea {
  key: string;
  search: any;
  criteria: any;
  funnel: { totalListings: number; screened: number; passing: number };
  centroid: { lat: number; lng: number } | null;
  boundaryGeoJson?: any;
  boundarySource?: string | null;
  zipCodes: string[];
  topListings?: Array<{
    id: string | null;
    address: string | null;
    zipCode: string | null;
    latitude: number | null;
    longitude: number | null;
    price: number | null;
    bedrooms: number | null;
    bathrooms: number | null;
    squareFootage: number | null;
    yearBuilt: number | null;
    daysOnMarket: number | null;
    propertyType: string | null;
    screen: ScreenResult | null;
  }>;
  listingCount: number;
  updatedAt: string;
  ageDays: number;
  recency: 'fresh' | 'recent' | 'stale';
}

export interface PropertyFlag {
  key: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  price: number | null;
  dealScore: number | null;
  note: string | null;
  updatedAt: string;
}

const BASE = '/api/v2';

async function post<T>(path: string, body: any): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text?.slice(0, 200) || `request_failed_${response.status}`);
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || payload?.error || `request_failed_${response.status}`);
  }
  return payload as T;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${BASE}${path}`);
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text?.slice(0, 200) || `request_failed_${response.status}`);
  }
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.message || payload?.error || `request_failed_${response.status}`);
  }
  return payload as T;
}

export const dealEngine = {
  screenerSearch(criteria: ScreenerCriteria): Promise<ScreenerResponse> {
    return post('/screener/search', criteria);
  },

  underwrite(listings: ScreenedListing[], options: { assumptions?: any; buyBox?: BuyBox; maxCount?: number } = {}) {
    return post<{ ok: boolean; underwritten: number; reports: DealReportData[]; errors: any[] }>('/screener/underwrite', {
      listings: listings.map((l) => ({
        address: l.formattedAddress,
        price: l.price,
        latitude: l.latitude,
        longitude: l.longitude,
        zipCode: l.zipCode,
        city: l.city,
        state: l.state,
        bedrooms: l.bedrooms,
        bathrooms: l.bathrooms,
        squareFootage: l.squareFootage,
        yearBuilt: l.yearBuilt,
        propertyType: l.propertyType,
      })),
      ...options,
    });
  },

  /**
   * Streaming individual analysis with progress events.
   */
  async analyzeProperty(
    params: { address: string; listPrice?: number | null; photos?: string[]; assumptions?: any },
    onProgress?: (stage: string, detail: string) => void,
  ): Promise<DealReportData> {
    const response = await fetch(`${BASE}/analysis/property?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, stream: true }),
    });

    if (!response.ok || !response.body) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || payload.error || `analysis_failed_${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let report: DealReportData | null = null;
    let errorPayload: any = null;

    const handleEvent = (eventName: string, data: any) => {
      if (eventName === 'progress' && onProgress) onProgress(data.stage, data.detail);
      else if (eventName === 'report') report = data;
      else if (eventName === 'error') errorPayload = data;
    };

    // Parse SSE frames
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex;
      while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        let eventName = 'message';
        let data = '';
        frame.split('\n').forEach((line) => {
          if (line.startsWith('event: ')) eventName = line.slice(7).trim();
          else if (line.startsWith('data: ')) data += line.slice(6);
        });
        if (data) {
          try {
            handleEvent(eventName, JSON.parse(data));
          } catch {
            // skip malformed frame
          }
        }
      }
    }

    if (errorPayload) throw new Error(errorPayload.message || errorPayload.error || 'analysis_failed');
    if (!report) throw new Error('analysis_no_report');
    return report;
  },

  recompute(assumptions: any, renovation: any | null, buyBox?: BuyBox) {
    return post<{
      ok: boolean;
      scenarios: DealScenario[];
      refiGrid: any;
      stressTest: any;
      offerSolver: any;
    }>('/analysis/recompute', { assumptions, renovation, buyBox });
  },

  listCoverage(): Promise<{ ok: boolean; coverage: CoverageArea[] }> {
    return get('/coverage');
  },

  getCoverage(key: string): Promise<{ ok: boolean; area: any }> {
    return get(`/coverage/${encodeURIComponent(key)}`);
  },

  listFlags(): Promise<{ ok: boolean; flags: PropertyFlag[] }> {
    return get('/flags');
  },

  setFlag(flag: { address: string; latitude?: number | null; longitude?: number | null; price?: number | null; dealScore?: number | null; flagged: boolean }) {
    return post<{ ok: boolean; key: string; flagged: boolean }>('/flags', flag);
  },

  environmentalRisk(address: string, lat?: number | null, lng?: number | null) {
    return fetch('/api/environmental-risk/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, latitude: lat, longitude: lng }),
    }).then(async (r) => {
      const payload = await r.json();
      if (!r.ok) throw new Error(payload.error || 'env_risk_failed');
      return payload;
    });
  },
};
