/**
 * Minimal type declarations for the shared (server + client) tax rules module.
 * Only the exports consumed from TypeScript are declared here; the runtime
 * implementation lives in taxRules.js.
 */

export declare const TAX_RULES_VERSION: string;
export declare const CURRENT_TAX_RULESET_TAX_YEAR: number;
export declare const CURRENT_TAX_RULESET_APPROVAL_STATUS: string;
export declare const TAX_BRACKETS_2023: Record<string, Array<{ min: number; max: number; rate: number }>>;
export declare const TAX_BRACKETS_2024: Record<string, Array<{ min: number; max: number; rate: number }>>;
export declare const TAX_BRACKETS_2025: Record<string, Array<{ min: number; max: number; rate: number }>>;
export declare const TAX_BRACKETS_2026: Record<string, Array<{ min: number; max: number; rate: number }>>;
export declare const STANDARD_DEDUCTION_2023: Record<string, number>;
export declare const STANDARD_DEDUCTION_2024: Record<string, number>;
export declare const STANDARD_DEDUCTION_2025: Record<string, number>;
export declare const STANDARD_DEDUCTION_2026: Record<string, number>;

export interface TaxRuleSourceDocumentRecord {
  id: string;
  authority: string;
  title: string;
  url: string | null;
  category: string | null;
  applicableYear: number | null;
  publishedLabel: string | null;
  pageUpdatedAt: string | null;
  lastReviewedAt: string | null;
  scope: string | null;
}

export interface TaxRulesGovernanceStatusRecord {
  requestedTaxYear: number;
  supportedTaxYear: number | null;
  rulesVersion: string | null;
  approvalStatus: string;
  coverageStatus: string;
  isRequestedTaxYearFullySupported: boolean;
  lastReviewedAt: string | null;
  rulesReviewAgeDays: number | null;
  freshnessStatus: string;
  staleAfterDays: number;
  sourceDocumentCount: number;
  staleSourcePageCount: number;
  staleSourcePages: Array<{ id: string; title: string; ageDays: number }>;
  warnings: string[];
}

export interface TaxRulesetPackageRecord {
  taxYear: number;
  referenceTaxYear: number | null;
  rulesVersion: string | null;
  approvalStatus: string;
  sourceCitations: string[];
  sourceDocuments: TaxRuleSourceDocumentRecord[];
  lastReviewedAt: string | null;
  governance: TaxRulesGovernanceStatusRecord;
  scopeSummary: string;
  estimatedTaxMethodology: string;
  stateTaxMethodology: string;
  [key: string]: unknown;
}

export declare function isSupportedTaxRulesYear(taxYear?: number): boolean;
export declare function getTaxRuleSourceDocuments(taxYear?: number): TaxRuleSourceDocumentRecord[];
export declare function getTaxRulesGovernanceStatus(taxYear?: number, asOfDate?: Date): TaxRulesGovernanceStatusRecord;
export declare function getTaxRulesetPackage(taxYear?: number): TaxRulesetPackageRecord;
export declare function getTax1099ThresholdForTaxYear(taxYear?: number): number;
export declare function formatTax1099Threshold(taxYear?: number): string;
export declare function getTax1099ThresholdSummary(taxYear?: number): string;
