import {
  buildBookkeepingTaxUrl,
  buildOwnerFinanceQuery,
  requestOwnerFinanceBlob,
  requestOwnerFinanceJson,
  type OwnerFinanceQueryValue,
} from './ownerFinanceApi';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

type QueryParams = Record<string, OwnerFinanceQueryValue>;

export const taxClient = {
  getYearSummary(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/year-summary${buildOwnerFinanceQuery(params)}`),
    );
  },

  getScheduleE(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/schedule-e${buildOwnerFinanceQuery(params)}`),
    );
  },

  getRulesPackage(year: number) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/rules-package${buildOwnerFinanceQuery({ year })}`),
    );
  },

  validateRulesPackage(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl('/rules-package/validate'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  getRulesPackageHistory(year: number) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/rules-package/history${buildOwnerFinanceQuery({ year })}`),
    );
  },

  ingestRulesPackage(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl('/rules-package/ingest'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  reviewTaxEdgeCases(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl('/edge-case-review'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  getWorkpaperSnapshot(year: number) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/workpaper-snapshot${buildOwnerFinanceQuery({ year })}`),
    );
  },

  getDraftFormProfile(params: QueryParams = {}) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/draft-form-profile${buildOwnerFinanceQuery(params)}`),
    );
  },

  getDocumentChecklist(year: number) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/document-checklist${buildOwnerFinanceQuery({ year })}`),
    );
  },

  getPacketReleaseIntelligence(year: number) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/packet-release-intelligence${buildOwnerFinanceQuery({ year })}`),
    );
  },

  listPacketReleases(year: number) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/packet-releases${buildOwnerFinanceQuery({ year })}`),
    );
  },

  get1099EfileStatus(year: number) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/1099-efile/status${buildOwnerFinanceQuery({ year })}`),
    );
  },

  calculateTax(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl('/calculate'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  persistWorkpaperSnapshot(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl('/workpaper-snapshot'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  saveDraftFormProfile(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl('/draft-form-profile'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  createPacketRelease(payload: Record<string, unknown>) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl('/packet-releases'),
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },

  downloadTxf(year: number) {
    return requestOwnerFinanceBlob(
      buildBookkeepingTaxUrl(`/export-txf${buildOwnerFinanceQuery({ year })}`),
    );
  },

  downloadCpaReviewPacket(params: QueryParams) {
    return requestOwnerFinanceBlob(
      buildBookkeepingTaxUrl(`/export-pdf${buildOwnerFinanceQuery(params)}`),
    );
  },

  downloadDraft1099Packet(year: number, homeState?: string) {
    return requestOwnerFinanceBlob(
      buildBookkeepingTaxUrl(`/export-1099-draft${buildOwnerFinanceQuery({ year, homeState })}`),
    );
  },

  downloadTaxDocumentPdf(year: number, docType: string, homeState?: string) {
    return requestOwnerFinanceBlob(
      buildBookkeepingTaxUrl(`/document-pdf${buildOwnerFinanceQuery({ year, docType, homeState })}`),
    );
  },

  downloadSummaryCsv(year: number) {
    return requestOwnerFinanceBlob(
      buildBookkeepingTaxUrl(`/export-csv${buildOwnerFinanceQuery({ year })}`),
    );
  },

  downloadDetailedCsv(year: number) {
    return requestOwnerFinanceBlob(
      buildBookkeepingTaxUrl(`/export-csv${buildOwnerFinanceQuery({ year, detailed: true })}`),
    );
  },

  download1099FormPdf(formId: string) {
    return requestOwnerFinanceBlob(
      buildBookkeepingTaxUrl(`/1099-form-pdf/${formId}`),
    );
  },

  /**
   * Merge ATTOM mortgage data into a bookkeeping property's metadata so the
   * tax checklist can display the lender name. Call this any time ATTOM
   * property data is available for a property that exists in the tax system.
   */
  enrichPropertyMortgage(propertyId: string, payload: {
    mortgageLender?: string;
    mortgageAmount?: number;
    mortgageRate?: number;
    mortgageDate?: string;
    mortgageTermMonths?: number;
  }) {
    return requestOwnerFinanceJson(
      buildBookkeepingTaxUrl(`/properties/${encodeURIComponent(propertyId)}/enrich-mortgage`),
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      },
      JSON_HEADERS,
    );
  },
};

export default taxClient;