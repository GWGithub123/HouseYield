// Renter's Insurance Policy Types

export interface RentersInsurancePolicy {
  insuranceCompany: string;
  policyNumber: string;
  policyHolder: string;
  coverageAmount: {
    personalProperty?: number;
    liability?: number;
    medicalPayments?: number;
  };
  effectiveDate: string;
  expirationDate: string;
  landlordListedAsInterested: boolean;
  uploadedDocument?: string; // base64 or URL
  parsedAt: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface COIParseResult {
  success: boolean;
  policy?: RentersInsurancePolicy;
  error?: string;
  rawText?: string;
}
