type NumericRange = { low: number; high: number };

export interface CanonicalRenovationResultLike {
  resultId?: string;
  source?: string;
  primaryKey?: string;
  canonicalOpportunityId?: string | null;
  canonicalRoomType?: string | null;
  canonicalCategory?: string | null;
  canonicalScopeType?: string | null;
  costEstimateId?: string;
  rentEstimateId?: string;
  valueEstimateId?: string;
  roiResultId?: string;
  totalCost?: number;
  costRange?: NumericRange;
  valueIncrease?: number;
  afterRepairValue?: number | null;
  rentIncreaseDollar?: number;
  rentIncreasePercent?: number;
  currentRent?: number;
  maxPostRenovationRent?: number;
  marketRentBenchmark?: number;
  marketSaleBenchmark?: number;
  roi?: number;
  paybackMonths?: number | null;
  confidence?: string;
  timeframe?: string;
}

export interface CanonicalRenovationSuggestionLike {
  id: string;
  cost?: number;
  costRange?: NumericRange;
  valueIncrease?: number;
  afterRepairValue?: number | null;
  rentIncreaseDollar?: number;
  rentIncreasePercent?: number;
  currentRent?: number;
  maxPostRenovationRent?: number;
  marketRentBenchmark?: number;
  marketSaleBenchmark?: number;
  roi?: number;
  paybackMonths?: number | null;
  confidence?: string;
  timeframe?: string;
  canonicalResult?: CanonicalRenovationResultLike | null;
}

export function normalizeCanonicalRenovationSuggestion<T extends CanonicalRenovationSuggestionLike>(suggestion: T): T {
  const canonicalResult = suggestion.canonicalResult;

  if (!canonicalResult?.resultId) {
    return suggestion;
  }

  return {
    ...suggestion,
    id: canonicalResult.resultId,
    cost: canonicalResult.totalCost ?? suggestion.cost,
    costRange: canonicalResult.costRange ?? suggestion.costRange,
    valueIncrease: canonicalResult.valueIncrease ?? suggestion.valueIncrease,
    afterRepairValue: canonicalResult.afterRepairValue ?? suggestion.afterRepairValue,
    rentIncreaseDollar: canonicalResult.rentIncreaseDollar ?? suggestion.rentIncreaseDollar,
    rentIncreasePercent: canonicalResult.rentIncreasePercent ?? suggestion.rentIncreasePercent,
    currentRent: canonicalResult.currentRent ?? suggestion.currentRent,
    maxPostRenovationRent: canonicalResult.maxPostRenovationRent ?? suggestion.maxPostRenovationRent,
    marketRentBenchmark: canonicalResult.marketRentBenchmark ?? suggestion.marketRentBenchmark,
    marketSaleBenchmark: canonicalResult.marketSaleBenchmark ?? suggestion.marketSaleBenchmark,
    roi: canonicalResult.roi ?? suggestion.roi,
    paybackMonths: canonicalResult.paybackMonths ?? suggestion.paybackMonths,
    confidence: canonicalResult.confidence ?? suggestion.confidence,
    timeframe: canonicalResult.timeframe ?? suggestion.timeframe,
  } as T;
}