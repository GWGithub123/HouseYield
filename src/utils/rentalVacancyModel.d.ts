export interface RentalVacancyBin {
  avgRent: number;
  avgVacancy: number;
  avgDom?: number;
  count?: number;
}

export interface RentalVacancyModel {
  anchorRent: number;
  baseVacancyRate?: number;
  compP25Rent?: number;
  compMedianRent?: number;
  compP75Rent?: number;
  compP90Rent?: number;
  supportedCeilingRent?: number;
  rentAtFullVacancy?: number;
  demandAdjustment?: number;
  domAdjustment?: number;
  listingsAdjustment?: number;
  mortgageAdjustment?: number;
  sentimentAdjustment?: number;
  employmentAdjustment?: number;
  minVacancyRate?: number;
  maxVacancyRate?: number;
  subjectCurrentRent?: number | null;
  subjectDaysOnMarket?: number | null;
  subjectStaleThresholdDays?: number | null;
  subjectMarketingPressure?: number | null;
  subjectListingIsStale?: boolean;
  marketLeaseUpDays?: number | null;
  leaseUpPriceElasticity?: number | null;
  subjectDomEvidenceWeight?: number | null;
  domBins?: { bins: RentalVacancyBin[] } | null;
}

export function estimateVacancyForRentModel(
  candidateRent: number,
  vacancyModel?: RentalVacancyModel | null,
  fallbacks?: { baseVacancyRate?: number | null },
): number | null;

export interface LeaseUpRecoveryEstimate {
  stabilizedVacancyRate: number;
  realizedVacancyPct: number;
  expectedAdditionalLeaseUpDays: number;
  projectedCampaignVacancyPct: number;
  marketLeaseUpDays?: number;
  subjectDomEvidenceWeight?: number;
}

export function estimateLeaseUpRecoveryForRent(
  candidateRent: number,
  vacancyModel?: RentalVacancyModel | null,
  fallbacks?: { baseVacancyRate?: number | null },
): LeaseUpRecoveryEstimate | null;
