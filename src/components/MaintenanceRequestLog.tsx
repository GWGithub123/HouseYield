import { useState, useEffect } from 'react';
import MaintenanceProgressTracker from './MaintenanceProgressTracker';
import PracticeTestPhoneSelector from './PracticeTestPhoneSelector';
import { formatPracticePhoneLabel, getStoredPracticeTestPhone } from '../utils/practiceTestPhone';
import { getDevApiBaseUrl } from '../utils/devApiBase';

interface AIAutomation {
  status: string;
  providerSearch?: {
    totalFound: number;
    analyzedCount: number;
  };
  selectedProvider?: {
    name: string;
    phone: string;
    rating: number;
    aiScore?: number;
    address?: string;
    isTrusted?: boolean;
    trustedNote?: string;
    reviewAnalysis?: {
      overallScore: number;
      recommendationLevel: string;
      summary: string;
      strengths?: string[];
      redFlags?: string[];
      suggestedQuestions?: string[];
    };
  };
  usedTrustedProvider?: boolean;
  callInitiated?: boolean;
  scheduledCall?: {
    scheduledFor: string;
    reason?: string;
  };
  callDetails?: {
    callSid?: string;
    targetPhone?: string;
    actualProviderPhone?: string;
    providerPhone?: string;
    initiatedAt?: string;
    note?: string;
  };
  callError?: string;
  error?: string;
}

interface ContractorAssignment {
  contractorId: string;
  contractorEmail: string;
  contractorName: string;
  contractorCompanyName: string;
  assignedAt: string | null;
  serviceCompletedAt: string | null;
}

interface ServiceCompletion {
  completedAt: string | null;
  completedBy: string;
  notes: string;
}

interface ScheduledVisit {
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

interface CallOutcome {
  callSid?: string;
  transcriptLineCount?: number;
  processedAt?: string;
}

interface OwnerSmsNotifications {
  enabled?: boolean;
  ownerPhone?: string;
  status?: 'pending' | 'confirmed' | 'declined' | 'send_failed' | 'skipped';
  sentAt?: string | null;
  confirmedAt?: string | null;
  declinedAt?: string | null;
  lastReply?: string | null;
  lastError?: string | null;
}

interface MaintenancePaymentWorkflow {
  status: string;
  amount: number | null;
  currency: string;
  serviceSummary: string;
  receiptNumber: string;
  contractorStripeAccountId: string;
  contractorOnboardingLinkSentAt: string | null;
  contractorOnboardingCompletedAt: string | null;
  ownerEmail?: string;
  ownerName?: string;
  ownerChargeRequestedAt: string | null;
  ownerChargeSucceededAt: string | null;
  ownerInvoiceUrl: string;
  ownerPaymentIntentId: string;
  ownerPaymentStatus: string;
  ownerPaymentMethodBankName: string;
  ownerPaymentMethodLast4: string;
  receiptUrl: string;
  lastError: string;
}

interface OwnerBillingStatus {
  connected: boolean;
  customerId: string | null;
  paymentMethod: {
    id: string;
    bankName: string;
    last4: string;
  } | null;
}

interface PaymentDraft {
  contractorId: string;
  contractorEmail: string;
  contractorName: string;
  contractorCompanyName: string;
  amount: string;
  serviceSummary: string;
}

interface MaintenanceRequest {
  id: string;
  category: string;
  serviceType: string;
  priority: string;
  description: string;
  location?: string;
  ownerId?: string;
  propertyId?: string;
  propertyAddress: string;
  unit?: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  contractorId?: string;
  contractorEmail?: string;
  contractorName?: string;
  contractorCompanyName?: string;
  contractorAssignment?: ContractorAssignment | null;
  serviceCompletion?: ServiceCompletion | null;
  paymentWorkflow?: MaintenancePaymentWorkflow | null;
  scheduledVisit?: ScheduledVisit | null;
  callOutcome?: CallOutcome | null;
  ownerSmsNotifications?: OwnerSmsNotifications | null;
  ownerConfirmed?: boolean;
  tenantAvailability?: string;
  tenantName?: string;
  tenantEmail?: string;
  aiAutomation: AIAutomation;
}

interface MaintenanceRequestLogProps {
  maxItems?: number;
  onRefresh?: () => void;
  ownerId?: string;
  ownerEmail?: string;
  ownerName?: string;
  propertyId?: string;
  /** Reports grouped request counts to the parent (for page-level KPI strips). */
  onStatsChange?: (stats: {
    open: number;
    urgent: number;
    awaitingApproval: number;
    resolved: number;
    total: number;
  }) => void;
  /** Reports the deduped request list to the parent (e.g. for a schedule/agenda panel). */
  onRequestsChange?: (requests: MaintenanceRequest[]) => void;
  /** Render without the outer border/card chrome (when embedded in a Card). */
  frameless?: boolean;
  /** Bump to force an immediate reload instead of waiting for the poll interval. */
  refreshKey?: number;
}

function createPaymentDraft(request: MaintenanceRequest): PaymentDraft {
  return {
    contractorId: request.contractorId || request.contractorAssignment?.contractorId || '',
    contractorEmail: request.contractorEmail || request.contractorAssignment?.contractorEmail || '',
    contractorName: request.contractorName || request.contractorAssignment?.contractorName || '',
    contractorCompanyName: request.contractorCompanyName || request.contractorAssignment?.contractorCompanyName || '',
    amount: request.paymentWorkflow?.amount ? String(request.paymentWorkflow.amount) : '',
    serviceSummary: request.paymentWorkflow?.serviceSummary || request.serviceCompletion?.notes || request.description || '',
  };
}

function getPaymentStatusLabel(status = '') {
  switch (status) {
    case 'awaiting_contractor_onboarding': return 'Awaiting Contractor Setup';
    case 'awaiting_owner_billing_setup': return 'Owner Billing Setup Required';
    case 'charging_owner': return 'Charging Owner';
    case 'owner_charge_processing': return 'Payment Processing';
    case 'paid': return 'Paid';
    case 'charge_failed': return 'Charge Failed';
    case 'not_started': return 'Not Started';
    default: return status ? status.replace(/_/g, ' ') : 'Not Started';
  }
}

function getPaymentStatusColor(status = '') {
  switch (status) {
    case 'paid': return 'bg-emerald-100 text-emerald-700';
    case 'owner_charge_processing':
    case 'charging_owner': return 'bg-blue-100 text-blue-700';
    case 'awaiting_contractor_onboarding':
    case 'awaiting_owner_billing_setup': return 'bg-amber-100 text-amber-700';
    case 'charge_failed': return 'bg-red-100 text-red-700';
    default: return 'bg-slate-100 text-slate-700';
  }
}

function formatCurrency(value: number | null | undefined, currency = 'usd') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: String(currency || 'usd').toUpperCase(),
  }).format(Number(value || 0));
}

const CLOSED_STATUSES = new Set(['resolved', 'completed', 'closed', 'cancelled', 'canceled', 'dismissed']);

function isRequestOpen(request: MaintenanceRequest): boolean {
  return !CLOSED_STATUSES.has(String(request.status || '').toLowerCase());
}

/** Strip emoji/symbol noise and normalize whitespace so sensor-generated
 *  descriptions ("🚨 FLOOD DETECTED 🚨 ...") compare and read cleanly. */
function cleanDescription(raw: string): string {
  return String(raw || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildDuplicateKey(request: MaintenanceRequest): string {
  const normalizedDescription = cleanDescription(request.description || '')
    .toLowerCase()
    .replace(/sensor\s*id[:\s]*[\w-]+/gi, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return [
    (request.propertyAddress || '').trim().toLowerCase(),
    (request.category || '').trim().toLowerCase(),
    normalizedDescription,
  ].join('|');
}

export default function MaintenanceRequestLog({ maxItems = 10, onRefresh, ownerId, ownerEmail, ownerName, propertyId, onStatsChange, onRequestsChange, frameless = false, refreshKey = 0 }: MaintenanceRequestLogProps) {
  const [requests, setRequests] = useState<MaintenanceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRequest, setExpandedRequest] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');
  const [testPhoneNumber, setTestPhoneNumber] = useState<string>(getStoredPracticeTestPhone());
  const [practiceMode, setPracticeMode] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, PaymentDraft>>({});
  const [saveLoadingId, setSaveLoadingId] = useState<string | null>(null);
  const [inviteLoadingId, setInviteLoadingId] = useState<string | null>(null);
  const [chargeLoadingId, setChargeLoadingId] = useState<string | null>(null);
  const [ownerBillingStatus, setOwnerBillingStatus] = useState<OwnerBillingStatus | null>(null);
  const [ownerBillingLoading, setOwnerBillingLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [confirmingOwnerBilling, setConfirmingOwnerBilling] = useState(false);

  const baseUrl = getDevApiBaseUrl();

  const fetchRequests = async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (ownerId) params.set('ownerId', ownerId);
      if (propertyId) params.set('propertyId', propertyId);
      params.set('practiceTestPhone', getStoredPracticeTestPhone());
      const query = params.toString();
      const response = await fetch(`${baseUrl}/api/maintenance/requests${query ? `?${query}` : ''}`);
      
      // Check if response is OK and is JSON
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        throw new Error('Server not available - ensure backend is running on port 3001');
      }
      
      const data = await response.json();
      
      if (data.ok) {
        const nextRequests = data.requests.slice(0, maxItems);
        setRequests(nextRequests);
        setTestPhoneNumber(data.testPhoneNumber || data.selectedPhone || getStoredPracticeTestPhone());
        setPracticeMode(Boolean(data.practiceMode));
        setDrafts((currentDrafts) => {
          const nextDrafts = { ...currentDrafts };
          nextRequests.forEach((request: MaintenanceRequest) => {
            if (!nextDrafts[request.id]) {
              nextDrafts[request.id] = createPaymentDraft(request);
            }
          });
          return nextDrafts;
        });
        setError(null);
      } else {
        setError(data.error || 'Failed to fetch requests');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to connect to server');
    } finally {
      setLoading(false);
    }
  };

  const fetchOwnerBillingStatus = async () => {
    if (!ownerId || !ownerEmail) {
      setOwnerBillingStatus(null);
      return;
    }

    try {
      setOwnerBillingLoading(true);
      const params = new URLSearchParams({
        ownerId,
        ownerEmail,
      });
      const response = await fetch(`${baseUrl}/api/maintenance/payments/owner-billing-status?${params.toString()}`);
      const data = await response.json();
      if (response.ok && data.ok) {
        setOwnerBillingStatus(data);
      }
    } catch (ownerBillingError) {
      console.error('[Maintenance Log] Failed to fetch owner billing status:', ownerBillingError);
    } finally {
      setOwnerBillingLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
    void fetchOwnerBillingStatus();
    // Poll for updates every 10 seconds
    const interval = setInterval(fetchRequests, 10000);
    return () => clearInterval(interval);
  }, [maxItems, ownerId, ownerEmail, propertyId, refreshKey]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const maintenanceBilling = params.get('maintenanceBilling');
    const setupSessionId = params.get('setup_session_id');

    if (maintenanceBilling === 'cancelled') {
      setActionMessage('Owner bank setup was cancelled. You can restart it from any maintenance payment card.');
      params.delete('maintenanceBilling');
      params.delete('setup_session_id');
      const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
      window.history.replaceState({}, '', nextUrl);
      return;
    }

    if (maintenanceBilling !== 'success' || !setupSessionId || confirmingOwnerBilling) {
      return;
    }

    setConfirmingOwnerBilling(true);
    fetch(`${baseUrl}/api/maintenance/payments/owner-billing/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setupSessionId }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error || 'Failed to confirm owner billing setup.');
        }

        setActionMessage('Owner maintenance billing is connected. Future contractor payouts can now charge the verified bank account automatically.');
        await Promise.all([fetchOwnerBillingStatus(), fetchRequests()]);
      })
      .catch((confirmError: any) => {
        console.error('[Maintenance Log] Failed to confirm owner billing setup:', confirmError);
        setError(confirmError.message || 'Failed to confirm owner billing setup.');
      })
      .finally(() => {
        setConfirmingOwnerBilling(false);
        params.delete('maintenanceBilling');
        params.delete('setup_session_id');
        const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
        window.history.replaceState({}, '', nextUrl);
      });
  }, [baseUrl, confirmingOwnerBilling, ownerEmail, ownerId]);

  const handleRefresh = () => {
    fetchRequests();
    void fetchOwnerBillingStatus();
    if (onRefresh) onRefresh();
  };

  const updateDraft = (requestId: string, field: keyof PaymentDraft, value: string) => {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [requestId]: {
        ...(currentDrafts[requestId] || { contractorId: '', contractorEmail: '', contractorName: '', contractorCompanyName: '', amount: '', serviceSummary: '' }),
        [field]: value,
      },
    }));
  };

  const handleSavePaymentDetails = async (request: MaintenanceRequest) => {
    const draft = drafts[request.id] || createPaymentDraft(request);
    const parsedAmount = Number(draft.amount);
    const amount = Number.isFinite(parsedAmount) && parsedAmount > 0
      ? parsedAmount
      : request.paymentWorkflow?.amount || null;

    try {
      setSaveLoadingId(request.id);
      setError(null);
      setActionMessage(null);

      const response = await fetch(`${baseUrl}/api/maintenance/payments/request/${encodeURIComponent(request.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractorId: draft.contractorId,
          contractorEmail: draft.contractorEmail,
          contractorName: draft.contractorName,
          contractorCompanyName: draft.contractorCompanyName,
          contractorAssignment: {
            contractorId: draft.contractorId,
            contractorEmail: draft.contractorEmail,
            contractorName: draft.contractorName,
            contractorCompanyName: draft.contractorCompanyName,
          },
          serviceCompletion: {
            completedAt: request.serviceCompletion?.completedAt || new Date().toISOString(),
            completedBy: request.serviceCompletion?.completedBy || 'owner',
            notes: draft.serviceSummary || request.description,
          },
          status: 'completed',
          paymentWorkflow: {
            amount,
            serviceSummary: draft.serviceSummary || request.description,
            ownerEmail: ownerEmail || request.paymentWorkflow?.ownerEmail || '',
            ownerName: ownerName || request.paymentWorkflow?.ownerName || '',
          },
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to save maintenance payment details.');
      }

      setActionMessage('Maintenance payment details saved. Send the contractor invite when you are ready to collect payout onboarding.');
      await fetchRequests();
    } catch (saveError: any) {
      console.error('[Maintenance Log] Failed to save payment details:', saveError);
      setError(saveError.message || 'Failed to save maintenance payment details.');
    } finally {
      setSaveLoadingId(null);
    }
  };

  const handleSendContractorInvite = async (request: MaintenanceRequest) => {
    const draft = drafts[request.id] || createPaymentDraft(request);
    const parsedAmount = Number(draft.amount);

    if (!draft.contractorEmail.trim()) {
      setError('Add the contractor email before sending a payout invite.');
      return;
    }

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('Enter a positive maintenance payment amount before sending a payout invite.');
      return;
    }

    try {
      setInviteLoadingId(request.id);
      setError(null);
      setActionMessage(null);

      const response = await fetch(`${baseUrl}/api/maintenance/payments/request/${encodeURIComponent(request.id)}/send-contractor-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractorId: draft.contractorId,
          contractorEmail: draft.contractorEmail,
          contractorName: draft.contractorName,
          contractorCompanyName: draft.contractorCompanyName,
          amount: parsedAmount,
          serviceSummary: draft.serviceSummary || request.description,
          ownerEmail: ownerEmail || '',
          ownerName: ownerName || '',
          serviceCompletedAt: request.serviceCompletion?.completedAt || new Date().toISOString(),
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to send the contractor payout invite.');
      }

      if (data.email?.ok) {
        setActionMessage(`Contractor invite sent to ${draft.contractorEmail}. They will land on the contractor payments page to connect Stripe payout details.`);
      } else {
        setActionMessage(data.inviteUrl
          ? `HouseYield saved the payout invite details, but email delivery is not configured. Use this link manually: ${data.inviteUrl}`
          : 'HouseYield saved the payout invite details, but email delivery is not configured.');
      }
      await fetchRequests();
    } catch (inviteError: any) {
      console.error('[Maintenance Log] Failed to send contractor invite:', inviteError);
      setError(inviteError.message || 'Failed to send the contractor payout invite.');
    } finally {
      setInviteLoadingId(null);
    }
  };

  const handleChargeOwner = async (request: MaintenanceRequest) => {
    const draft = drafts[request.id] || createPaymentDraft(request);

    try {
      setChargeLoadingId(request.id);
      setError(null);
      setActionMessage(null);

      const response = await fetch(`${baseUrl}/api/maintenance/payments/request/${encodeURIComponent(request.id)}/charge-owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contractorId: draft.contractorId || request.contractorId || request.contractorAssignment?.contractorId || '',
          contractorEmail: draft.contractorEmail || request.contractorEmail || request.contractorAssignment?.contractorEmail || '',
          contractorName: draft.contractorName || request.contractorName || request.contractorAssignment?.contractorName || '',
          contractorStripeAccountId: request.paymentWorkflow?.contractorStripeAccountId || '',
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to charge the owner for this maintenance request.');
      }

      setActionMessage(data.requiresOwnerBillingSetup
        ? 'The contractor is ready, but the owner billing bank account still needs to be connected before payment can be released.'
        : 'The owner charge was submitted and the receipt workflow has been updated.');
      await Promise.all([fetchRequests(), fetchOwnerBillingStatus()]);
    } catch (chargeError: any) {
      console.error('[Maintenance Log] Failed to charge owner:', chargeError);
      setError(chargeError.message || 'Failed to charge the owner for this maintenance request.');
    } finally {
      setChargeLoadingId(null);
    }
  };

  const handleConnectOwnerBilling = async (request: MaintenanceRequest) => {
    if (!ownerId || !ownerEmail) {
      setError('Owner account information is required before connecting maintenance billing.');
      return;
    }

    try {
      setOwnerBillingLoading(true);
      setError(null);

      const response = await fetch(`${baseUrl}/api/maintenance/payments/owner-billing/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerId,
          ownerEmail,
          ownerName: ownerName || '',
          propertyId: request.propertyId || propertyId || '',
          propertyAddress: request.propertyAddress,
        }),
      });

      const data = await response.json();
      if (!response.ok || !data.ok || !data.url) {
        throw new Error(data.error || 'Failed to create the owner bank setup session.');
      }

      window.location.href = data.url;
    } catch (billingError: any) {
      console.error('[Maintenance Log] Failed to create owner billing setup session:', billingError);
      setError(billingError.message || 'Failed to create the owner bank setup session.');
    } finally {
      setOwnerBillingLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'provider_found': return 'bg-green-100 text-green-700';
      case 'awaiting_owner_confirmation': return 'bg-blue-100 text-blue-700';
      case 'pending': return 'bg-yellow-100 text-yellow-700';
      case 'processing': return 'bg-blue-100 text-blue-700';
      case 'in_progress': return 'bg-blue-100 text-blue-700';
      case 'scheduled': return 'bg-purple-100 text-purple-700';
      case 'scheduled_for_callback': return 'bg-indigo-100 text-indigo-700';
      case 'completed': return 'bg-green-100 text-green-700';
      case 'no_provider_found': return 'bg-orange-100 text-orange-700';
      case 'error': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'provider_found': return 'Provider Found';
      case 'awaiting_owner_confirmation': return 'Awaiting Owner SMS';
      case 'pending': return 'Pending';
      case 'processing': return 'Processing';
      case 'in_progress': return 'In Progress';
      case 'scheduled': return 'Scheduled';
      case 'scheduled_for_callback': return 'Call Scheduled';
      case 'completed': return 'Completed';
      case 'no_provider_found': return 'No Provider';
      case 'error': return 'Error';
      default: return status.replace(/_/g, ' ');
    }
  };

  const getScheduledCallReasonLabel = (reason?: string) => {
    switch (reason) {
      case 'outside_business_hours':
        return 'Provider is currently closed — call queued for next business opening';
      case 'no-answer':
        return 'No answer on last attempt — retry scheduled';
      case 'busy':
        return 'Line was busy — retry scheduled';
      case 'failed':
        return 'Previous call failed — retry scheduled';
      case 'canceled':
        return 'Previous call was canceled — retry scheduled';
      default:
        return reason
          ? reason.replace(/_/g, ' ')
          : 'Call queued until the provider is likely available';
    }
  };

  const formatScheduledCallTime = (dateStr?: string) => {
    if (!dateStr) {
      return 'Pending';
    }

    const scheduledAt = new Date(dateStr);
    if (Number.isNaN(scheduledAt.getTime())) {
      return 'Pending';
    }

    const now = new Date();
    const isFuture = scheduledAt.getTime() > now.getTime();
    const formatted = scheduledAt.toLocaleString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

    if (!isFuture) {
      return `${formatted} (due now)`;
    }

    const diffMinutes = Math.round((scheduledAt.getTime() - now.getTime()) / (60 * 1000));
    if (diffMinutes < 60) {
      return `${formatted} (in ${diffMinutes} min)`;
    }

    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) {
      return `${formatted} (in ${diffHours} hr${diffHours === 1 ? '' : 's'})`;
    }

    return formatted;
  };

  const formatScheduledCallBadge = (dateStr?: string) => {
    if (!dateStr) {
      return 'Scheduled';
    }

    const scheduledAt = new Date(dateStr);
    if (Number.isNaN(scheduledAt.getTime())) {
      return 'Scheduled';
    }

    return scheduledAt.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent': case 'emergency': return 'bg-red-100 text-red-700';
      case 'high': return 'bg-orange-100 text-orange-700';
      case 'normal': return 'bg-blue-100 text-blue-700';
      case 'low': return 'bg-gray-100 text-gray-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) {
      return 'Pending';
    }

    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) {
      return 'Pending';
    }

    return date.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Collapse duplicate reports (same property + category + description) into one row.
  const groupedRequests: Array<{ request: MaintenanceRequest; duplicateCount: number }> = [];
  {
    const seen = new Map<string, number>();
    for (const request of requests) {
      const key = buildDuplicateKey(request);
      const existingIndex = seen.get(key);
      if (existingIndex === undefined) {
        seen.set(key, groupedRequests.length);
        groupedRequests.push({ request, duplicateCount: 1 });
      } else {
        groupedRequests[existingIndex].duplicateCount += 1;
      }
    }
  }

  const openGroups = groupedRequests.filter((group) => isRequestOpen(group.request));
  const visibleGroups = statusFilter === 'open' ? openGroups : groupedRequests;
  const closedCount = groupedRequests.length - openGroups.length;
  const urgentCount = openGroups.filter((g) => ['urgent', 'emergency', 'high'].includes(String(g.request.priority || '').toLowerCase())).length;
  const awaitingCount = openGroups.filter((g) => {
    const status = String(g.request.aiAutomation?.status || '').toLowerCase();
    return status.includes('await') || status.includes('pending') || status.includes('provider');
  }).length;

  useEffect(() => {
    onStatsChange?.({
      open: openGroups.length,
      urgent: urgentCount,
      awaitingApproval: awaitingCount,
      resolved: closedCount,
      total: groupedRequests.length,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaitingCount, closedCount, groupedRequests.length, onStatsChange, openGroups.length, urgentCount]);

  const scheduleSignature = groupedRequests
    .map((group) => `${group.request.id}:${group.request.status}:${group.request.scheduledVisit?.startAt || ''}:${group.request.aiAutomation?.scheduledCall?.scheduledFor || ''}`)
    .join('|');

  useEffect(() => {
    onRequestsChange?.(groupedRequests.map((group) => group.request));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleSignature, onRequestsChange]);

  const shellClass = frameless
    ? 'overflow-hidden bg-white'
    : 'overflow-hidden border border-slate-200 bg-white';

  if (loading && requests.length === 0) {
    return (
      <div className={frameless ? 'p-6' : 'border border-slate-200 bg-white p-6'}>
        <div className="flex items-center gap-2 text-gray-500">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span>Loading maintenance requests...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="inline-flex border border-slate-200 bg-white p-0.5">
            <button
              onClick={() => setStatusFilter('open')}
              className={`px-3 py-1 text-xs font-semibold transition ${statusFilter === 'open' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              Open ({openGroups.length})
            </button>
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1 text-xs font-semibold transition ${statusFilter === 'all' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              All ({groupedRequests.length})
            </button>
          </div>
          {loading && (
            <svg className="w-4 h-4 animate-spin text-gray-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ownerBillingStatus && (
            <div className={`text-xs px-2 py-1 rounded ${ownerBillingStatus.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
              {ownerBillingStatus.connected
                ? `Owner billing: ${ownerBillingStatus.paymentMethod?.bankName || 'Connected'} •••• ${ownerBillingStatus.paymentMethod?.last4 || ''}`
                : 'Owner billing not connected'}
            </div>
          )}
          {confirmingOwnerBilling && (
            <div className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded">
              Confirming owner billing...
            </div>
          )}
          {practiceMode && testPhoneNumber && (
            <span className="text-[11px] text-purple-600" title={`Practice SMS: ${formatPracticePhoneLabel(testPhoneNumber)}`}>
              Practice mode
            </span>
          )}
          <button 
            onClick={handleRefresh}
            className="border border-slate-200 bg-white px-3 py-1.5 text-xs transition-colors hover:bg-slate-100"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="p-4 bg-red-50 border-b border-red-100">
          <div className="text-sm text-red-700">{error}</div>
        </div>
      )}

      {actionMessage && (
        <div className="p-4 bg-blue-50 border-b border-blue-100">
          <div className="text-sm text-blue-700">{actionMessage}</div>
        </div>
      )}

      {practiceMode && (
        <div className="border-b border-purple-100 px-4 py-2">
          <PracticeTestPhoneSelector compact />
        </div>
      )}

      {/* Request list — contained scroll so the page doesn't flood */}
      <div className="max-h-[min(520px,58vh)] divide-y divide-slate-100 overflow-y-auto">
        {visibleGroups.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {requests.length === 0 ? (
              <>
                <div className="text-sm font-semibold text-slate-700">No maintenance requests yet</div>
                <div className="text-xs text-gray-400 mt-1">Requests submitted from the tenant portal will appear here</div>
              </>
            ) : (
              <>
                <div className="text-sm font-semibold text-slate-700">No open requests</div>
                <div className="text-xs text-gray-400 mt-1">
                  {closedCount} resolved request{closedCount === 1 ? '' : 's'} hidden —{' '}
                  <button onClick={() => setStatusFilter('all')} className="font-semibold text-slate-600 underline hover:text-slate-800">show all</button>
                </div>
              </>
            )}
          </div>
        ) : (
          visibleGroups.map(({ request, duplicateCount }) => (
            <div key={request.id} className="transition-colors hover:bg-slate-50">
              <div 
                className="cursor-pointer px-4 py-2.5"
                onClick={() => setExpandedRequest(expandedRequest === request.id ? null : request.id)}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex flex-wrap items-center gap-1.5">
                      <span className={`px-2 py-0.5 text-[11px] font-semibold uppercase ${getPriorityColor(request.priority)}`}>
                        {request.priority}
                      </span>
                      {duplicateCount > 1 && (
                        <span className="bg-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                          {duplicateCount}× grouped
                        </span>
                      )}
                      <span className="text-[11px] text-slate-500">{request.category}</span>
                      <span className="text-[11px] text-slate-400">{formatDate(request.createdAt)}</span>
                    </div>
                    <div className="line-clamp-1 text-sm font-medium text-slate-900">
                      {cleanDescription(request.description) || 'Maintenance request'}
                    </div>
                    {!propertyId && request.propertyAddress ? (
                      <div className="mt-0.5 text-xs text-slate-500">{request.propertyAddress}</div>
                    ) : null}
                  </div>
                  
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <span className={`whitespace-nowrap px-2 py-0.5 text-[11px] font-semibold ${getStatusColor(request.aiAutomation.status)}`}>
                      {getStatusLabel(request.aiAutomation.status)}
                    </span>
                    <svg 
                      className={`h-4 w-4 text-slate-400 transition-transform ${expandedRequest === request.id ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              </div>

              {/* Expanded details */}
              {expandedRequest === request.id && (
                <div className="px-4 pb-4 border-t bg-gray-50">
                  <div className="mt-3 space-y-4">
                    <div
                      className="bg-white rounded-lg border p-4"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <MaintenanceProgressTracker
                        request={request}
                        baseUrl={baseUrl}
                        formatDate={formatDate}
                        formatCurrency={formatCurrency}
                      />
                    </div>

                    {/* Request Details */}
                    <div>
                      <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Request Details</div>
                      <div className="bg-white rounded-lg border p-3 text-sm space-y-1">
                        <div><span className="text-gray-500">ID:</span> <span className="font-mono text-xs">{request.id}</span></div>
                        <div><span className="text-gray-500">Category:</span> {request.category} ({request.serviceType})</div>
                        <div><span className="text-gray-500">Location:</span> {request.location || 'Not specified'}</div>
                        <div><span className="text-gray-500">Unit:</span> {request.unit || 'N/A'}</div>
                        <div><span className="text-gray-500">Availability:</span> {request.tenantAvailability || 'Not provided'}</div>
                        <div><span className="text-gray-500">Description:</span> {request.description}</div>
                      </div>
                    </div>

                    {/* Contractor Payment Workflow */}
                    <div>
                      <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Contractor Payment Workflow</div>
                      <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                        <div className="bg-white rounded-lg border p-3 space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={`text-xs px-2 py-1 rounded-full ${getPaymentStatusColor(request.paymentWorkflow?.status || '')}`}>
                              {getPaymentStatusLabel(request.paymentWorkflow?.status || '')}
                            </span>
                            <span className={`text-xs px-2 py-1 rounded-full ${ownerBillingStatus?.connected ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                              {ownerBillingStatus?.connected ? 'Owner ACH Ready' : 'Owner ACH Needed'}
                            </span>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2 text-sm">
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide">Service summary</div>
                              <div className="mt-1 text-gray-800">{request.paymentWorkflow?.serviceSummary || request.description}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide">Amount</div>
                              <div className="mt-1 font-semibold text-gray-900">{formatCurrency(request.paymentWorkflow?.amount, request.paymentWorkflow?.currency)}</div>
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide">Contractor</div>
                              <div className="mt-1 text-gray-800">{request.contractorAssignment?.contractorName || request.contractorName || 'Not assigned yet'}</div>
                              {(request.contractorAssignment?.contractorEmail || request.contractorEmail) && (
                                <div className="text-xs text-gray-500 mt-1">{request.contractorAssignment?.contractorEmail || request.contractorEmail}</div>
                              )}
                            </div>
                            <div>
                              <div className="text-xs text-gray-500 uppercase tracking-wide">Owner charge</div>
                              <div className="mt-1 text-gray-800">{formatDate(request.paymentWorkflow?.ownerChargeRequestedAt || request.paymentWorkflow?.ownerChargeSucceededAt)}</div>
                              {request.paymentWorkflow?.ownerPaymentStatus && (
                                <div className="text-xs text-gray-500 mt-1">Stripe status: {request.paymentWorkflow.ownerPaymentStatus}</div>
                              )}
                            </div>
                          </div>

                          {(request.paymentWorkflow?.receiptNumber || request.paymentWorkflow?.receiptUrl || request.paymentWorkflow?.ownerInvoiceUrl) && (
                            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                              <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                  <div className="text-xs text-gray-500 uppercase tracking-wide">Receipt</div>
                                  <div className="mt-1 font-medium text-gray-900">{request.paymentWorkflow?.receiptNumber || 'Pending receipt number'}</div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  {request.paymentWorkflow?.ownerInvoiceUrl && (
                                    <a href={request.paymentWorkflow.ownerInvoiceUrl} className="text-sm font-medium text-blue-600 hover:text-blue-700">
                                      Owner receipt
                                    </a>
                                  )}
                                  {request.paymentWorkflow?.receiptUrl && (
                                    <a href={request.paymentWorkflow.receiptUrl} className="text-sm font-medium text-emerald-600 hover:text-emerald-700">
                                      Contractor receipt
                                    </a>
                                  )}
                                </div>
                              </div>
                            </div>
                          )}

                          {request.paymentWorkflow?.lastError && (
                            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                              {request.paymentWorkflow.lastError}
                            </div>
                          )}
                        </div>

                        <div className="bg-white rounded-lg border p-3 space-y-3">
                          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">Invite and billing details</div>
                          <div className="grid gap-3">
                            <input
                              type="text"
                              value={drafts[request.id]?.contractorName ?? createPaymentDraft(request).contractorName}
                              onChange={(event) => updateDraft(request.id, 'contractorName', event.target.value)}
                              placeholder="Contractor name"
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                            />
                            <input
                              type="text"
                              value={drafts[request.id]?.contractorCompanyName ?? createPaymentDraft(request).contractorCompanyName}
                              onChange={(event) => updateDraft(request.id, 'contractorCompanyName', event.target.value)}
                              placeholder="Company name"
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                            />
                            <input
                              type="email"
                              value={drafts[request.id]?.contractorEmail ?? createPaymentDraft(request).contractorEmail}
                              onChange={(event) => updateDraft(request.id, 'contractorEmail', event.target.value)}
                              placeholder="contractor@company.com"
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                            />
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={drafts[request.id]?.amount ?? createPaymentDraft(request).amount}
                              onChange={(event) => updateDraft(request.id, 'amount', event.target.value)}
                              placeholder="Maintenance payment amount"
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                            />
                            <textarea
                              value={drafts[request.id]?.serviceSummary ?? createPaymentDraft(request).serviceSummary}
                              onChange={(event) => updateDraft(request.id, 'serviceSummary', event.target.value)}
                              placeholder="Service summary shown in payout emails and receipts"
                              rows={4}
                              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-100"
                            />
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => handleSavePaymentDetails(request)}
                              disabled={saveLoadingId === request.id}
                              className="rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {saveLoadingId === request.id ? 'Saving...' : 'Save Details'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSendContractorInvite(request)}
                              disabled={inviteLoadingId === request.id}
                              className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {inviteLoadingId === request.id ? 'Sending invite...' : 'Send Payout Invite'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleConnectOwnerBilling(request)}
                              disabled={ownerBillingLoading}
                              className="rounded-full border border-blue-200 px-4 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {ownerBillingLoading ? 'Opening Stripe...' : ownerBillingStatus?.connected ? 'Update Owner ACH' : 'Connect Owner ACH'}
                            </button>
                            {['awaiting_owner_billing_setup', 'charge_failed', 'charging_owner'].includes(request.paymentWorkflow?.status || '') && request.paymentWorkflow?.contractorStripeAccountId && (
                              <button
                                type="button"
                                onClick={() => handleChargeOwner(request)}
                                disabled={chargeLoadingId === request.id}
                                className="rounded-full border border-amber-200 px-4 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {chargeLoadingId === request.id ? 'Submitting charge...' : 'Retry Owner Charge'}
                              </button>
                            )}
                          </div>

                          <p className="text-xs text-gray-500">
                            After the contractor connects Stripe, HouseYield charges the owner&apos;s verified bank account, stores receipts in both portals, and emails payment confirmations automatically.
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* AI Provider Selection */}
                    {request.aiAutomation.selectedProvider && (
                      <div>
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                          {request.aiAutomation.usedTrustedProvider ? (
                            <>
                              <span className="text-amber-500">⭐</span>
                              Trusted Provider
                            </>
                          ) : (
                            'AI Selected Provider'
                          )}
                        </div>
                        <div className={`bg-white rounded-lg border p-3 ${request.aiAutomation.usedTrustedProvider ? 'border-amber-200 bg-amber-50/30' : ''}`}>
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="font-medium text-gray-900 flex items-center gap-2">
                                {request.aiAutomation.usedTrustedProvider && <span className="text-amber-500">⭐</span>}
                                {request.aiAutomation.selectedProvider.name}
                              </div>
                              <div className="text-sm text-gray-600 mt-1">📞 {request.aiAutomation.selectedProvider.phone}</div>
                              {request.aiAutomation.selectedProvider.address && (
                                <div className="text-sm text-gray-500">{request.aiAutomation.selectedProvider.address}</div>
                              )}
                              {request.aiAutomation.selectedProvider.trustedNote && (
                                <div className="text-xs text-amber-600 mt-2 p-2 bg-amber-50 rounded">
                                  💡 {request.aiAutomation.selectedProvider.trustedNote}
                                </div>
                              )}
                            </div>
                            <div className="text-right">
                              <div className="flex items-center gap-1">
                                <span className="text-yellow-500">★</span>
                                <span className="font-medium">{request.aiAutomation.selectedProvider.rating}</span>
                              </div>
                              {request.aiAutomation.selectedProvider.aiScore && !request.aiAutomation.usedTrustedProvider && (
                                <div className="text-xs text-purple-600 mt-1">
                                  AI Score: {request.aiAutomation.selectedProvider.aiScore}/100
                                </div>
                              )}
                              {request.aiAutomation.usedTrustedProvider && (
                                <div className="text-xs text-amber-600 mt-1">
                                  Pre-approved
                                </div>
                              )}
                            </div>
                          </div>
                          
                          {/* Review Analysis */}
                          {request.aiAutomation.selectedProvider.reviewAnalysis && !request.aiAutomation.usedTrustedProvider && (
                            <div className="mt-3 pt-3 border-t">
                              <div className="text-xs text-gray-700 mb-2">
                                <strong>AI Analysis:</strong> {request.aiAutomation.selectedProvider.reviewAnalysis.summary}
                              </div>
                              
                              {request.aiAutomation.selectedProvider.reviewAnalysis.strengths && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {request.aiAutomation.selectedProvider.reviewAnalysis.strengths.map((s, i) => (
                                    <span key={i} className="text-xs px-2 py-0.5 bg-green-50 text-green-700 rounded">
                                      ✓ {s}
                                    </span>
                                  ))}
                                </div>
                              )}
                              
                              {request.aiAutomation.selectedProvider.reviewAnalysis.redFlags && 
                               request.aiAutomation.selectedProvider.reviewAnalysis.redFlags.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {request.aiAutomation.selectedProvider.reviewAnalysis.redFlags.map((f, i) => (
                                    <span key={i} className="text-xs px-2 py-0.5 bg-red-50 text-red-700 rounded">
                                      ⚠ {f}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Scheduled Call */}
                    {request.aiAutomation.scheduledCall?.scheduledFor && (
                      <div>
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Scheduled Provider Call</div>
                        <div className="bg-indigo-50 rounded-lg border border-indigo-200 p-3 text-sm space-y-2">
                          <div className="font-medium text-indigo-900">
                            🕐 Scheduled call at {formatScheduledCallTime(request.aiAutomation.scheduledCall.scheduledFor)}
                          </div>
                          <div className="text-indigo-800">
                            {getScheduledCallReasonLabel(request.aiAutomation.scheduledCall.reason)}
                          </div>
                          {request.aiAutomation.selectedProvider?.phone && (
                            <div className="text-indigo-700">
                              <span className="text-indigo-500">Provider:</span>{' '}
                              {request.aiAutomation.selectedProvider.name} ({request.aiAutomation.selectedProvider.phone})
                            </div>
                          )}
                          <div className="text-xs text-indigo-600">
                            Ava will automatically call when the provider is likely open and available.
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Call Details */}
                    {request.aiAutomation.callDetails && (
                      <div>
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Voice Call Details</div>
                        <div className="bg-white rounded-lg border p-3 text-sm space-y-1">
                          {request.aiAutomation.callDetails.callSid && (
                            <div><span className="text-gray-500">Call SID:</span> <span className="font-mono text-xs">{request.aiAutomation.callDetails.callSid}</span></div>
                          )}
                          {request.aiAutomation.callDetails.targetPhone && (
                            <div><span className="text-gray-500">Called Number:</span> {request.aiAutomation.callDetails.targetPhone}</div>
                          )}
                          {(request.aiAutomation.callDetails.actualProviderPhone || request.aiAutomation.callDetails.providerPhone) && (
                            <div>
                              <span className="text-gray-500">Provider Number:</span>{' '}
                              {request.aiAutomation.callDetails.actualProviderPhone || request.aiAutomation.callDetails.providerPhone}
                            </div>
                          )}
                          {request.aiAutomation.callDetails.initiatedAt && (
                            <div><span className="text-gray-500">Initiated:</span> {formatDate(request.aiAutomation.callDetails.initiatedAt)}</div>
                          )}
                          {request.aiAutomation.callDetails.note && (
                            <div className="text-xs text-purple-600 mt-2 p-2 bg-purple-50 rounded">
                              ℹ️ {request.aiAutomation.callDetails.note}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Error */}
                    {(request.aiAutomation.error || request.aiAutomation.callError) && (
                      <div className="bg-red-50 rounded-lg border border-red-200 p-3 text-sm text-red-700">
                        ❌ {request.aiAutomation.error || request.aiAutomation.callError}
                      </div>
                    )}

                    {/* Search Stats */}
                    {request.aiAutomation.providerSearch && (
                      <div className="text-xs text-gray-500">
                        Found {request.aiAutomation.providerSearch.totalFound} providers, analyzed {request.aiAutomation.providerSearch.analyzedCount}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
