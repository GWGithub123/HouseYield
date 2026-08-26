/**
 * Shared maintenance ticket shapes.
 *
 * Imported by the customer app and by the internal ops console (via the `@shared`
 * alias), so both surfaces agree on what a ticket looks like.
 */

import type {
  AvailabilitySelection,
  MaintenancePhoto,
  MaintenancePriority,
  MaintenanceTriage,
  PropertyAccess,
} from '../../services/maintenanceApi';

export type { AvailabilitySelection, MaintenancePhoto, MaintenancePriority, PropertyAccess };

export interface ProviderReviewAnalysis {
  overallScore?: number;
  recommendationLevel?: string;
  expertiseMatch?: number | string;
  responsiveness?: number | string;
  qualityOfWork?: number | string;
  professionalism?: number | string;
  pricingFairness?: number | string;
  redFlags?: string[];
  strengths?: string[];
  summary?: string;
  suggestedQuestions?: string[];
}

export interface ProviderCandidate {
  placeId?: string;
  name: string;
  phone?: string;
  address?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  lat?: number;
  lng?: number;
  /** 0–100 composite from the AI review analysis. */
  aiScore?: number;
  selectionReasoning?: string;
  reviewAnalysis?: ProviderReviewAnalysis | null;
  isTrusted?: boolean;
  trustedNote?: string;
}

/** Logged by the operator after they place the booking call themselves. */
export type OperatorCallOutcome = 'booked' | 'quoted' | 'callback' | 'no_answer' | 'declined' | '';

export interface OperatorCallLog {
  calledAt?: string | null;
  calledBy?: string;
  providerName?: string;
  providerPhone?: string;
  outcome?: OperatorCallOutcome;
  notes?: string;
}

export interface AiAutomation {
  status: string;
  providerSearch?: { totalFound: number; analyzedCount: number } | null;
  selectedProvider?: ProviderCandidate | null;
  /** Ranked candidates the operator picks from. */
  providerShortlist?: ProviderCandidate[];
  /** Talking points generated alongside the shortlist. */
  callScript?: string;
  operatorCall?: OperatorCallLog | null;
  usedTrustedProvider?: boolean;
  callInitiated?: boolean;
  callDetails?: {
    callSid?: string;
    targetPhone?: string;
    actualProviderPhone?: string;
    providerPhone?: string;
    initiatedAt?: string;
    note?: string;
  };
  scheduledCall?: { scheduledFor: string; reason?: string };
  callError?: string;
  error?: string;
}

export interface ScheduledVisit {
  confirmed?: boolean;
  startAt: string;
  endAt?: string;
  timezone?: string;
  providerName?: string;
  providerPhone?: string;
  summary?: string;
  confirmedAt?: string;
  googleCalendarUrl?: string;
}

export interface ServicePart {
  name: string;
  manufacturer?: string;
  modelNumber?: string;
  partNumber?: string;
  category?: string;
  quantity: number;
  unitCost: number | null;
  warrantyMonths?: number | null;
}

export interface ServiceLabor {
  hours: number | null;
  rate: number | null;
  cost: number | null;
}

export interface ServiceTotals {
  parts: number | null;
  labor: number | null;
  tax: number | null;
  total: number | null;
}

export interface ServiceWarranty {
  months: number | null;
  expiresAt: string | null;
  terms: string;
}

export interface ServicePhotoSets {
  before: MaintenancePhoto[];
  after: MaintenancePhoto[];
  parts: MaintenancePhoto[];
  receipt: MaintenancePhoto[];
}

export interface ServiceRecord {
  completedAt: string | null;
  completedBy: string;
  providerId: string;
  providerName: string;
  diagnosis: string;
  workPerformed: string;
  parts: ServicePart[];
  labor: ServiceLabor;
  totals: ServiceTotals;
  photos: ServicePhotoSets;
  warranty: ServiceWarranty;
  followUpRecommended: boolean;
  followUpDueAt: string | null;
  notes: string;
}

export interface MaintenanceOutcome {
  resolvedFirstVisit: boolean | null;
  repeatIssue: boolean;
  repeatOfRequestId: string;
  verifiedAt: string | null;
  ownerRating: number | null;
  notes: string;
}

export interface MaintenancePaymentWorkflow {
  status: string;
  amount: number | null;
  currency: string;
  serviceSummary: string;
  receiptNumber: string;
  ownerChargeSucceededAt: string | null;
  ownerInvoiceUrl: string;
  receiptUrl: string;
}

export interface OwnerSmsNotifications {
  enabled?: boolean;
  ownerPhone?: string;
  status?: 'pending' | 'confirmed' | 'declined' | 'send_failed' | 'skipped';
  sentAt?: string | null;
  confirmedAt?: string | null;
  declinedAt?: string | null;
  lastReply?: string | null;
  lastError?: string | null;
}

export interface OperatorLogEntry {
  at: string;
  actorEmail: string;
  actorName: string;
  event: string;
  step: string;
  note: string;
}

export interface TicketIntake {
  mode: 'ai_chat' | 'form';
  transcript: Array<{ role: 'user' | 'assistant'; content: string; at?: string | null }>;
  extracted: MaintenanceTriage | null;
  completedAt: string | null;
}

export interface MaintenanceTicket {
  id: string;
  firestoreId?: string;
  category: string;
  serviceType?: string;
  priority: MaintenancePriority | string;
  description: string;
  location?: string;
  status: string;
  createdAt: string;
  updatedAt?: string;

  propertyAddress: string;
  propertyId?: string;
  unit?: string;

  ownerId?: string;
  ownerEmail?: string;
  ownerName?: string;
  tenantId?: string;
  tenantEmail?: string;
  tenantName?: string;
  submittedBy?: { role: string; userId: string; name: string; email: string } | null;

  tenantAvailability?: string;
  availabilityWindows?: AvailabilitySelection[];
  propertyAccess?: PropertyAccess | null;
  intake?: TicketIntake | null;
  photos?: MaintenancePhoto[];
  triageSummary?: string;

  aiAutomation: AiAutomation;
  scheduledVisit?: ScheduledVisit | null;
  callOutcome?: { callSid?: string; transcriptLineCount?: number; processedAt?: string } | null;
  serviceCompletion?: { completedAt: string | null; completedBy: string; notes: string } | null;
  serviceRecord?: ServiceRecord | null;
  outcome?: MaintenanceOutcome | null;
  paymentWorkflow?: MaintenancePaymentWorkflow | null;
  ownerSmsNotifications?: OwnerSmsNotifications | null;
  ownerConfirmed?: boolean;
  operatorLog?: OperatorLogEntry[];
}

export const OPERATOR_CALL_OUTCOME_LABELS: Record<Exclude<OperatorCallOutcome, ''>, string> = {
  booked: 'Visit booked',
  quoted: 'Quote given',
  callback: 'Will call back',
  no_answer: 'No answer',
  declined: 'Declined the job',
};

/** Sum of parts and labor, used when an operator has not entered explicit totals. */
export function computeServiceTotals(parts: ServicePart[], labor: ServiceLabor, tax: number | null): ServiceTotals {
  const partsTotal = parts.reduce((sum, part) => {
    const quantity = Number(part.quantity) || 0;
    const unitCost = Number(part.unitCost) || 0;
    return sum + quantity * unitCost;
  }, 0);

  const laborCost = labor.cost !== null && labor.cost !== undefined
    ? Number(labor.cost) || 0
    : (Number(labor.hours) || 0) * (Number(labor.rate) || 0);

  const taxAmount = Number(tax) || 0;

  return {
    parts: partsTotal,
    labor: laborCost,
    tax: taxAmount,
    total: partsTotal + laborCost + taxAmount,
  };
}
