import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Home } from 'lucide-react';
import DocumentManager from '../components/DocumentManager';
import TenantActivityPanel from '../components/TenantActivityPanel';
import TenantInterviewScheduler from '../components/TenantInterviewScheduler';
import TenantOnboardingModal from '../components/TenantOnboardingModal';
import TenantPaymentForm from '../components/TenantPaymentForm';
import MaintenanceRequestLog from '../components/MaintenanceRequestLog';
import FinancialReservesAnalytics from '../components/FinancialReservesAnalytics';
import { FinanceSourceTruthBanner, buildFinanceSourceMix } from '../components/finance/FinanceSourceTruth';
import LandlordBankSetup from '../components/LandlordBankSetup';
import PhoneCallSystem from '../components/PhoneCallSystem';
import StripeBookkeepingIntegration from '../components/StripeBookkeepingIntegration';
import TaxPanel from '../components/TaxPanel';
import MaintenanceProviderHub from '../components/MaintenanceProviderHub';
import MaintenanceIntakeFlow from '../components/maintenance/MaintenanceIntakeFlow';
import ProviderNetworkMap from '../components/maintenance/ProviderNetworkMap';
import MaintenanceRequestForm from '../components/MaintenanceRequestForm';
import { useAuth } from '../contexts/AuthContext';
import { useVoiceActionHandler } from '../contexts/VoiceCommandContext';
import { getDefaultBookkeepingDateRange, useFirestoreBookkeeping } from '../hooks/useFirestoreBookkeeping';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import { getSavedProperties, type SavedProperty } from '../utils/savedProperties';
import { buildVoiceUiAttrs } from '../utils/voiceUi';
import WorkspaceTabsHeader from '../components/WorkspaceTabsHeader';
import {
  Badge,
  Card,
  CardHeader,
  KpiStrip,
  PageShell,
  SubTabs,
} from '../design-system';
import {
  getDefaultManagementTab,
  getManagementNavLabel,
  getManagementTabs,
  isMaintenanceProduct,
  normalizeManagementTab,
  type ManagementTabId,
} from '../product/productMode';

type ManagementTab = ManagementTabId;
type ViewMode = 'single' | 'combined';

const ALL_MANAGEMENT_TABS: Array<{ id: ManagementTab; label: string; description: string }> = [
  { id: 'documents', label: 'Documents', description: 'Leases, uploads, signatures, and records.' },
  { id: 'tenants', label: 'Tenants', description: 'Messages, payments, and maintenance activity.' },
  { id: 'maintenance', label: 'Maintenance', description: 'Requests, providers, and repair status.' },
  { id: 'tax', label: 'Tax Center', description: 'Schedule E, deadlines, and tax planning.' },
];

function getVisibleManagementTabs() {
  const allowed = new Set(getManagementTabs());
  return ALL_MANAGEMENT_TABS.filter((tab) => allowed.has(tab.id));
}

function normalizeTab(value: string | null): ManagementTab | null {
  return normalizeManagementTab(value);
}

function buildPropertyScopeId(_ownerId: string | undefined, property: SavedProperty | undefined): string | undefined {
  // Owner properties already use canonical Firestore IDs (often `ownerId_…`).
  // Do not re-prefix — DocumentManager / leases / tenants all key off this same id.
  return property?.id || undefined;
}

function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function buildExpenseCategories(transactions: Array<{ type: string; category: string; amount: number }>) {
  const totals = new Map<string, number>();

  transactions
    .filter((transaction) => transaction.type === 'expense')
    .forEach((transaction) => {
      const key = transaction.category || 'Uncategorized';
      totals.set(key, (totals.get(key) || 0) + Math.abs(Number(transaction.amount || 0)));
    });

  return Array.from(totals.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([name, amount]) => ({ name, amount, type: 'expense' as const }));
}

type MaintenanceScheduleEvent = {
  id: string;
  date: Date;
  type: 'visit' | 'call';
  title: string;
  subtitle?: string;
  request: any;
};

function buildScheduleEvents(requests: any[]): MaintenanceScheduleEvent[] {
  const events: MaintenanceScheduleEvent[] = [];

  requests.forEach((request) => {
    const visitAt = request?.scheduledVisit?.startAt ? new Date(request.scheduledVisit.startAt) : null;
    if (visitAt && !Number.isNaN(visitAt.getTime())) {
      events.push({
        id: `${request.id}-visit`,
        date: visitAt,
        type: 'visit',
        title: request.scheduledVisit?.providerName ? `${request.scheduledVisit.providerName} — visit` : 'Provider visit',
        subtitle: request.description,
        request,
      });
    }

    const callAt = request?.aiAutomation?.scheduledCall?.scheduledFor ? new Date(request.aiAutomation.scheduledCall.scheduledFor) : null;
    if (callAt && !Number.isNaN(callAt.getTime())) {
      events.push({
        id: `${request.id}-call`,
        date: callAt,
        type: 'call',
        title: request.aiAutomation?.selectedProvider?.name ? `Call ${request.aiAutomation.selectedProvider.name}` : 'Provider call',
        subtitle: request.description,
        request,
      });
    }
  });

  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function formatAgendaDate(date: Date) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfTarget.getTime() - startOfToday.getTime()) / 86400000);
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  if (diffDays === 0) return `Today · ${time}`;
  if (diffDays === 1) return `Tomorrow · ${time}`;
  if (diffDays === -1) return `Yesterday · ${time}`;

  const dateLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${dateLabel} · ${time}`;
}

function buildSummary(transactions: Array<{ type: string; amount: number }>) {
  const totalIncome = transactions
    .filter((transaction) => transaction.type === 'income')
    .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0);
  const totalExpenses = transactions
    .filter((transaction) => transaction.type === 'expense')
    .reduce((sum, transaction) => sum + Math.abs(Number(transaction.amount || 0)), 0);
  const netCashFlow = totalIncome - totalExpenses;

  return {
    totalIncome,
    totalExpenses,
    netCashFlow,
    margin: totalIncome > 0 ? Number(((netCashFlow / totalIncome) * 100).toFixed(1)) : 0,
  };
}

function TenantWorkspace({
  ownerId,
  ownerEmail,
  propertyScopeId,
  selectedProperty,
  connectedTenant,
  connectedTenants,
}: {
  ownerId?: string;
  ownerEmail?: string;
  propertyScopeId?: string;
  selectedProperty?: SavedProperty;
  connectedTenant?: any;
  connectedTenants?: any[];
}) {
  const propertyAddress = selectedProperty?.address || 'Selected property';

  // ── Sub-navigation ───────────────────────────────────────
  const [subTab, setSubTab] = useState<'roster' | 'screening' | 'payments' | 'listings'>('roster');
  const [showScreeningInterviews, setShowScreeningInterviews] = useState(false);

  // ── Screening ────────────────────────────────────────────
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showScreeningForm, setShowScreeningForm] = useState(false);
  const [screeningRequests, setScreeningRequests] = useState<any[]>([]);
  const [screeningInterviews, setScreeningInterviews] = useState<any[]>([]);
  const [screeningName, setScreeningName] = useState('');
  const [screeningEmail, setScreeningEmail] = useState('');
  const [sendingScreening, setSendingScreening] = useState(false);
  const [screeningResult, setScreeningResult] = useState<{ ok: boolean; error?: string; message?: string } | null>(null);
  const [equifaxConfigured, setEquifaxConfigured] = useState<boolean | null>(null);
  const [applicationLink, setApplicationLink] = useState('');

  // ── Messages + AI ────────────────────────────────────────
  const [messages, setMessages] = useState<any[]>([]);
  const [aiAnalysis, setAiAnalysis] = useState<any>(null);
  const [analyzingMsgs, setAnalyzingMsgs] = useState(false);

  // ── Payments + Stripe ────────────────────────────────────
  const [payments, setPayments] = useState<any[]>([]);
  const [stripeAccountId, setStripeAccountId] = useState<string | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentTenantName, setPaymentTenantName] = useState('');
  const [paymentTenantEmail, setPaymentTenantEmail] = useState('');

  const openTenantOnboarding = useCallback(() => {
    setSubTab('roster');
    setShowOnboarding(true);
  }, []);

  const openPaymentRequest = useCallback(() => {
    setSubTab('payments');
    setShowPaymentModal(true);
  }, []);

  const openTenantMessages = useCallback(() => {
    setSubTab('roster');
    window.setTimeout(() => {
      document.querySelector('[data-voice-id="property-management-messages-activity"]')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 100);
  }, []);

  useVoiceActionHandler('add-tenant', openTenantOnboarding, [openTenantOnboarding]);
  useVoiceActionHandler('property-management-add-tenant', openTenantOnboarding, [openTenantOnboarding]);
  useVoiceActionHandler('open-payment-modal', openPaymentRequest, [openPaymentRequest]);
  useVoiceActionHandler('property-management-send-payment-request', openPaymentRequest, [openPaymentRequest]);
  useVoiceActionHandler('open-messaging-modal', openTenantMessages, [openTenantMessages]);

  // ── Discovery / Listings ─────────────────────────────────
  const [listings, setListings] = useState<any[]>([]);
  const [showCreateListing, setShowCreateListing] = useState(false);
  const [newListing, setNewListing] = useState({
    title: '', description: '', price: '', bedrooms: '', bathrooms: '', sqft: '',
  });
  const [creatingListing, setCreatingListing] = useState(false);

  // ── Initial data load ────────────────────────────────────
  useEffect(() => {
    fetch('/api/equifax/status')
      .then(r => r.json()).then(d => setEquifaxConfigured(d.configured || d.valid || false)).catch(() => setEquifaxConfigured(false));

    if (!ownerId) return;
    const pid = propertyScopeId ? `&propertyId=${encodeURIComponent(propertyScopeId)}` : '';
    const screeningParams = new URLSearchParams({ ownerId });
    if (propertyAddress) screeningParams.set('propertyAddress', propertyAddress);
    if (propertyScopeId) screeningParams.set('propertyId', propertyScopeId);

    fetch(`/api/screening/requests/all?${screeningParams.toString()}`)
      .then(r => r.json()).then(d => { if (d.ok) setScreeningRequests(d.requests || []); }).catch(() => {});

    fetch(`/api/interviews?ownerId=${encodeURIComponent(ownerId)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          const allInterviews = d.interviews || [];
          setScreeningInterviews(
            propertyAddress
              ? allInterviews.filter((interview: any) => interview.propertyAddress === propertyAddress)
              : allInterviews
          );
        }
      }).catch(() => {});

    fetch('/api/screening/application-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerId,
        ownerName: ownerEmail || ownerId,
        propertyId: propertyScopeId,
        propertyAddress,
      })
    }).then(r => r.json()).then(d => {
      if (d.ok) setApplicationLink(d.applicationLink || '');
    }).catch(() => {});

    fetch(`/api/owner/messages?ownerId=${encodeURIComponent(ownerId)}${pid}`)
      .then(r => r.json()).then(d => { if (d.ok) setMessages(d.messages || []); }).catch(() => {});

    // Load Stripe account first, then pull payment history directly from Stripe
    fetch(`/api/stripe-connect/accounts/${encodeURIComponent(ownerId)}`)
      .then(r => r.json()).then(async d => {
        const accts = d.accounts || d;
        if (Array.isArray(accts) && accts.length) {
          const accountId = accts[0].accountId || accts[0].id || null;
          setStripeAccountId(accountId);
          // Fetch payment history directly from Stripe using the connected account
          if (accountId) {
            try {
              const pr = await fetch(`/api/stripe-connect/owner-payment-history?accountId=${encodeURIComponent(accountId)}`);
              const pd = await pr.json();
              if (pd.ok && pd.payments?.length > 0) {
                setPayments(pd.payments);
                return;
              }
            } catch (_e) { /* fall through to Firestore */ }
          }
        }
        // Firestore fallback
        fetch(`/api/owner/payments?ownerId=${encodeURIComponent(ownerId)}${pid}`)
          .then(r => r.json()).then(d => { if (d.ok) setPayments(d.payments || []); }).catch(() => {});
      }).catch(() => {
        // Firestore fallback if Stripe accounts fetch fails
        fetch(`/api/owner/payments?ownerId=${encodeURIComponent(ownerId)}${pid}`)
          .then(r => r.json()).then(d => { if (d.ok) setPayments(d.payments || []); }).catch(() => {});
      });

    fetch(`/api/listings?userId=${encodeURIComponent(ownerId)}${pid}`)
      .then(r => r.json()).then(d => {
        if (Array.isArray(d)) setListings(d);
        else if (d.listings) setListings(d.listings);
      }).catch(() => {});
  }, [ownerId, propertyScopeId]);

  // ── Handlers ─────────────────────────────────────────────
  const handleSendScreening = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendingScreening(true);
    setScreeningResult(null);
    try {
      const res = await fetch('/api/screening/send-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicantName: screeningName,
          applicantEmail: screeningEmail,
          propertyAddress,
          ownerName: ownerEmail || ownerId || 'Landlord',
          ownerId: ownerId || 'owner-1',
        }),
      });
      const data = await res.json();
      setScreeningResult(data);
      if (data.ok) {
        setScreeningName('');
        setScreeningEmail('');
        const screeningParams = new URLSearchParams({ ownerId: ownerId || '' });
        if (propertyAddress) screeningParams.set('propertyAddress', propertyAddress);
        if (propertyScopeId) screeningParams.set('propertyId', propertyScopeId);
        fetch(`/api/screening/requests/all?${screeningParams.toString()}`).then(r => r.json())
          .then(d => { if (d.ok) setScreeningRequests(d.requests || []); }).catch(() => {});
      }
    } catch (_e) {
      setScreeningResult({ ok: false, error: 'Network error — please try again' });
    } finally {
      setSendingScreening(false);
    }
  };

  const handleAnalyzeMessages = async () => {
    if (!messages.length) return;
    setAnalyzingMsgs(true);
    try {
      const res = await fetch('/api/tenant-messages/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages.slice(0, 20).map(m => ({
            id: m.id,
            content: m.message || m.content || '',
            date: m.createdAt,
            from: m.tenantName || 'Tenant',
            subject: m.subject || 'Message',
          })),
          propertyAddress,
        }),
      });
      setAiAnalysis(await res.json());
    } catch (_e) { /* silent */ }
    finally { setAnalyzingMsgs(false); }
  };

  const handleCreateListing = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingListing(true);
    try {
      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newListing,
          price: parseFloat(newListing.price) || 0,
          bedrooms: parseInt(newListing.bedrooms) || 0,
          bathrooms: parseFloat(newListing.bathrooms) || 0,
          sqft: parseInt(newListing.sqft) || 0,
          propertyAddress,
          userId: ownerId,
          status: 'active',
        }),
      });
      const data = await res.json();
      if (data.id || data.ok) {
        setListings(prev => [data.listing || data, ...prev]);
        setShowCreateListing(false);
        setNewListing({ title: '', description: '', price: '', bedrooms: '', bathrooms: '', sqft: '' });
      }
    } catch (_e) { /* silent */ }
    finally { setCreatingListing(false); }
  };

  // ── Computed ─────────────────────────────────────────────
  const unreadCount = messages.filter(m => m.status === 'unread').length;
  const totalCollected = payments
    .filter(p => p.status === 'completed')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  const pendingAmount = payments
    .filter(p => p.status === 'pending')
    .reduce((sum, p) => sum + (p.amount || 0), 0);
  const activeTenantCount = connectedTenants?.filter((t: any) => t.status === 'active' || t.isActive).length || 0;
  const pendingScreeningCount = screeningRequests.filter((r: any) => !['completed', 'expired', 'rejected'].includes(r.status)).length;
  const pendingPaymentCount = payments.filter(p => p.status === 'pending').length;
  const failedPaymentCount = payments.filter(p => p.status === 'failed').length;

  const screeningEntries = useMemo(() => (
    screeningRequests.map((request) => {
      const matchingInterview = screeningInterviews.find((interview: any) =>
        (request.interviewId && interview.id === request.interviewId) ||
        (
          interview.applicantEmail?.toLowerCase() === request.applicantEmail?.toLowerCase() &&
          interview.propertyAddress === request.propertyAddress
        )
      );

      return {
        ...request,
        interview: matchingInterview || null,
      };
    })
  ), [screeningInterviews, screeningRequests]);

  const screeningApplicants = useMemo(() => (
    screeningEntries.map((entry) => ({
      id: String(entry.id),
      name: entry.submittedFirstName && entry.submittedLastName
        ? `${entry.submittedFirstName} ${entry.submittedLastName}`
        : entry.applicantName,
      email: entry.applicantEmail,
      phone: entry.applicantPhone,
      appliedDate: entry.createdAt,
      status: (entry.status === 'completed' ? 'approved' : entry.status === 'expired' ? 'rejected' : 'pending') as 'pending' | 'approved' | 'rejected',
      creditScore: entry.creditScore,
      backgroundCheck: (entry.backgroundStatus === 'clear' ? 'clear' : entry.backgroundStatus === 'flagged' ? 'flagged' : 'pending') as 'pending' | 'clear' | 'flagged',
      incomeVerification: {
        verified: !!entry.incomeVerified,
        monthlyIncome: entry.incomeData?.monthlyIncome,
        employmentStatus: entry.incomeData?.employmentStatus,
      }
    }))
  ), [screeningEntries]);

  const handleCopyApplicationLink = async () => {
    if (!applicationLink) return;
    try {
      await navigator.clipboard.writeText(applicationLink);
      window.alert('Application link copied to clipboard.');
    } catch (_err) {
      window.alert('Unable to copy the application link.');
    }
  };

  return (
    <div
      {...buildVoiceUiAttrs({
        id: 'property-management-tenants-panel',
        label: 'Tenant management workspace',
        type: 'section',
        description: 'Tenant onboarding, screening, communications, payments, and vacancy listing tools.',
        pageSection: 'property-management-content',
      })}
      className="space-y-6"
    >
      {/* ── Hero KPIs ── */}
      <KpiStrip
        items={[
          {
            label: 'Occupied',
            value: String(activeTenantCount),
            sub: `${connectedTenants?.length || 0} on roster`,
            onClick: () => setSubTab('roster'),
          },
          {
            label: 'Unread messages',
            value: String(unreadCount),
            sub: 'Awaiting review',
            tone: unreadCount > 0 ? 'negative' : 'default',
            onClick: () => setSubTab('roster'),
          },
          {
            label: 'Screening',
            value: String(pendingScreeningCount),
            sub: 'Open applications',
            onClick: () => setSubTab('screening'),
          },
          {
            label: 'Pending rent',
            value: `$${pendingAmount.toLocaleString()}`,
            sub: `${pendingPaymentCount} awaiting payment`,
            onClick: () => setSubTab('payments'),
          },
        ]}
      />

      {/* ── Sub-navigation ── */}
      <SubTabs
        tabs={[
          { id: 'roster', label: 'Roster & Messages', accent: 'sky' },
          { id: 'screening', label: 'Screening', accent: 'violet' },
          { id: 'payments', label: 'Rent & Payments', accent: 'emerald' },
          { id: 'listings', label: 'Listings', accent: 'amber' },
        ]}
        activeId={subTab}
        onChange={(id) => setSubTab(id as typeof subTab)}
      />

      {subTab === 'roster' && (
      <div className="grid gap-4 xl:grid-cols-2">
        <Card flushBody>
          <CardHeader
            title="Tenant roster"
            subtitle="Current tenants for this property."
            right={
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setShowOnboarding(true)}
                  className="border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
                >Add tenant</button>
                <button
                  className="border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
                >Export</button>
              </div>
            }
          />
          <div className="overflow-x-auto border-t border-slate-200">
            <div className="grid min-w-[560px] grid-cols-5 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
              <div>Tenant</div><div>Lease</div><div>Rent</div><div>Status</div><div />
            </div>
            {connectedTenants && connectedTenants.length > 0 ? (
              connectedTenants.map((t: any, i: number) => (
                <div key={t.tenantId || t.email || i} className="grid min-w-[560px] grid-cols-5 items-center border-t border-slate-100 px-4 py-3 text-sm hover:bg-slate-50">
                  <div className="flex items-center gap-2">
                    {t.photoURL ? (
                      <img src={t.photoURL} alt="" className="h-7 w-7 flex-shrink-0 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                        {(t.name || t.tenantName || t.email || 'T').charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-900">{t.name || t.tenantName || t.email || 'Tenant'}</div>
                      {t.unit ? <div className="text-xs text-slate-500">Unit {t.unit}</div> : null}
                    </div>
                  </div>
                  <div className="text-xs text-slate-600">
                    {t.leaseStart || t.leaseEnd
                      ? `${t.leaseStart ? new Date(t.leaseStart).toLocaleDateString() : '—'} – ${t.leaseEnd ? new Date(t.leaseEnd).toLocaleDateString() : '—'}`
                      : '—'}
                  </div>
                  <div className="font-semibold tabular-nums text-slate-900">{t.monthlyRent ? `$${Number(t.monthlyRent).toLocaleString()}` : '—'}</div>
                  <div>
                    <Badge tone={t.status === 'active' || t.isActive ? 'success' : 'neutral'} dot>
                      {t.status || (t.isActive ? 'Active' : 'Inactive')}
                    </Badge>
                  </div>
                  <div className="text-right text-xs font-semibold text-blue-600">View</div>
                </div>
              ))
            ) : (
              <div className="px-4 py-12 text-center text-slate-500">
                <div className="text-sm font-semibold text-slate-700">No tenants yet</div>
                <div className="mt-1 text-xs">Add a tenant to start tracking lease and rent details.</div>
              </div>
            )}
          </div>
        </Card>

        <Card flushBody>
          <CardHeader
            title="Messages & activity"
            subtitle="Tenant messages and maintenance activity."
            right={
              <div className="flex items-center gap-2">
                {unreadCount > 0 && <Badge tone="danger" dot>{unreadCount} unread</Badge>}
                <button
                  onClick={handleAnalyzeMessages}
                  disabled={analyzingMsgs || messages.length === 0}
                  className="border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                >
                  {analyzingMsgs ? 'Analyzing…' : 'AI analyze'}
                </button>
              </div>
            }
          />
          {aiAnalysis && (
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              {aiAnalysis.messagesAnalyzed} message{aiAnalysis.messagesAnalyzed !== 1 ? 's' : ''} analyzed ·{' '}
              {aiAnalysis.maintenanceIssues || 0} maintenance issue{(aiAnalysis.maintenanceIssues || 0) !== 1 ? 's' : ''} detected
              <button onClick={() => setAiAnalysis(null)} className="ml-3 text-xs font-semibold text-slate-500 underline">Dismiss</button>
            </div>
          )}
          <div className="border-t border-slate-200 p-3">
            {ownerId ? (
              <TenantActivityPanel ownerId={ownerId} propertyId={propertyScopeId} />
            ) : (
              <div className="border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                Sign in to view tenant messages and activity.
              </div>
            )}
          </div>
        </Card>
      </div>
      )}

      {/* ── Screening ── */}
      {subTab === 'screening' && (
      <div className="space-y-4">
        <Card flushBody>
          <CardHeader
            title="Applicant screening"
            subtitle="Share your application link and review incoming applicants."
            right={
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={handleCopyApplicationLink}
                  disabled={!applicationLink}
                  className="border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  Copy application link
                </button>
                <button
                  onClick={() => { setShowScreeningForm((f) => !f); setScreeningResult(null); }}
                  className="bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-violet-700"
                >
                  {showScreeningForm ? 'Cancel' : 'Invite applicant'}
                </button>
              </div>
            }
          />

          <div className="space-y-4 border-t border-slate-200 p-4">
            {applicationLink && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 sm:w-32">Application link</span>
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                  <span className="flex-1 truncate">{applicationLink}</span>
                  <button type="button" onClick={handleCopyApplicationLink} className="text-xs font-semibold text-blue-600 hover:underline">Copy</button>
                </div>
              </div>
            )}

            {equifaxConfigured !== null && (
              <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${equifaxConfigured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${equifaxConfigured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                {equifaxConfigured ? 'Equifax connected' : 'Equifax sandbox mode'}
              </div>
            )}

            {showScreeningForm && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900">Send screening invitation</div>
                <p className="mt-1 text-xs text-slate-600">Applicant receives a secure link for credit, background, and income verification.</p>
                {screeningResult?.ok && (
                  <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                    {screeningResult.message || 'Invitation sent successfully.'}
                  </div>
                )}
                {screeningResult && !screeningResult.ok && (
                  <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                    {screeningResult.error || 'Failed to send invitation.'}
                  </div>
                )}
                {!screeningResult?.ok && (
                  <form onSubmit={handleSendScreening} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-medium text-slate-600">Applicant name</label>
                      <input required value={screeningName} onChange={(e) => setScreeningName(e.target.value)} placeholder="Jane Smith" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-500" />
                    </div>
                    <div className="flex-1">
                      <label className="mb-1 block text-xs font-medium text-slate-600">Applicant email</label>
                      <input required type="email" value={screeningEmail} onChange={(e) => setScreeningEmail(e.target.value)} placeholder="applicant@email.com" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-violet-500" />
                    </div>
                    <button type="submit" disabled={sendingScreening} className="whitespace-nowrap rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50">
                      {sendingScreening ? 'Sending…' : 'Send invite'}
                    </button>
                  </form>
                )}
              </div>
            )}

            {screeningRequests.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <div className="grid grid-cols-[1.4fr_0.8fr_1.4fr_1.2fr_0.8fr] bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                  <div>Applicant</div><div>Submitted</div><div>Checks</div><div>Interview</div><div>Status</div>
                </div>
                {screeningEntries.map((req: any) => (
                  <div key={req.id} className="grid grid-cols-[1.4fr_0.8fr_1.4fr_1.2fr_0.8fr] items-center border-t border-slate-100 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50">
                    <div>
                      <div className="font-medium">{req.submittedFirstName && req.submittedLastName ? `${req.submittedFirstName} ${req.submittedLastName}` : req.applicantName || '—'}</div>
                      <div className="text-xs text-slate-400">{req.applicantEmail || ''}</div>
                    </div>
                    <div className="text-xs text-slate-500">{req.updatedAt ? new Date(req.updatedAt).toLocaleDateString() : req.createdAt ? new Date(req.createdAt).toLocaleDateString() : '—'}</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {req.creditScore
                        ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${Number(req.creditScore) >= 650 ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>Credit {req.creditScore}</span>
                        : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Credit pending</span>}
                      {req.backgroundStatus === 'clear'
                        ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Background clear</span>
                        : req.backgroundStatus === 'flagged'
                        ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">Background flagged</span>
                        : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Background pending</span>}
                      {req.incomeVerified
                        ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Income verified</span>
                        : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Income pending</span>}
                    </div>
                    <div>
                      {req.interview ? (
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          req.interview.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                          req.interview.status === 'scheduled' ? 'bg-sky-100 text-sky-700' :
                          'bg-amber-100 text-amber-700'
                        }`}>
                          {req.interview.status === 'pending_booking' ? 'Awaiting booking' : req.interview.status.replace(/_/g, ' ')}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">Not scheduled</span>
                      )}
                    </div>
                    <div>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        req.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                        req.status === 'expired' ? 'bg-rose-100 text-rose-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {req.status || 'pending'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center">
                <div className="text-sm font-semibold text-slate-700">No applications yet</div>
                <div className="mt-1 text-xs text-slate-500">Share your application link or send a direct invite to get started.</div>
              </div>
            )}
          </div>
        </Card>

        <Card flushBody>
          <button
            type="button"
            onClick={() => setShowScreeningInterviews((open) => !open)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
            aria-expanded={showScreeningInterviews}
          >
            <div>
              <div className="text-sm font-semibold text-slate-900">Phone interviews</div>
              <div className="text-xs text-slate-500">Schedule and review applicant phone interviews.</div>
            </div>
            <svg className={`h-5 w-5 text-slate-400 transition-transform ${showScreeningInterviews ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showScreeningInterviews && (
            <div className="border-t border-slate-200 p-4">
              <TenantInterviewScheduler
                applicants={screeningApplicants}
                propertyAddress={propertyAddress}
                ownerId={ownerId}
                ownerName={ownerEmail}
              />
            </div>
          )}
        </Card>
      </div>
      )}

      {/* ── Payments ── */}
      {subTab === 'payments' && (
      <div className="space-y-4">
        <KpiStrip
          items={[
            { label: 'Collected', value: `$${totalCollected.toLocaleString()}`, sub: `${payments.filter((p) => p.status === 'completed').length} completed` },
            { label: 'Pending', value: `$${pendingAmount.toLocaleString()}`, sub: `${pendingPaymentCount} awaiting`, tone: pendingPaymentCount > 0 ? 'negative' : 'default' },
            { label: 'Failed', value: String(failedPaymentCount), sub: 'Need follow-up', tone: failedPaymentCount > 0 ? 'negative' : 'default' },
          ]}
          columns={3}
        />

        <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
          <Card flushBody>
            <CardHeader
              title="Payment history"
              subtitle="Recent rent payments for this property."
              right={
                <button
                  onClick={() => setShowPaymentModal(true)}
                  className="bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700"
                >
                  Send payment request
                </button>
              }
            />
            {payments.length > 0 ? (
              <div className="max-h-[min(420px,50vh)] overflow-y-auto border-t border-slate-200">
                <div className="grid grid-cols-5 bg-slate-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
                  <div>Tenant</div><div>Date</div><div>Amount</div><div>Method</div><div>Status</div>
                </div>
                {payments.slice(0, 20).map((pay: any) => (
                  <div key={pay.id} className="grid grid-cols-5 border-t border-slate-100 px-4 py-3 text-sm text-slate-700 hover:bg-slate-50">
                    <div>
                      <div className="font-medium">{pay.tenantName || pay.tenantEmail || '—'}</div>
                      {pay.unit ? <div className="text-xs text-slate-400">Unit {pay.unit}</div> : null}
                    </div>
                    <div className="text-xs text-slate-500">
                      {(pay.date || pay.paymentDate) ? new Date(pay.date || pay.paymentDate).toLocaleDateString() : '—'}
                    </div>
                    <div className="font-semibold tabular-nums">${(pay.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                    <div className="text-xs text-slate-500">
                      {(() => {
                        const m = pay.paymentMethod || pay.method || '';
                        if (m === 'us_bank_account') return 'ACH';
                        if (m === 'card') return 'Card';
                        return m || 'Stripe';
                      })()}
                    </div>
                    <div>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                        pay.status === 'completed' ? 'bg-emerald-100 text-emerald-700'
                        : pay.status === 'failed' ? 'bg-rose-100 text-rose-700'
                        : 'bg-amber-100 text-amber-700'
                      }`}>
                        {pay.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="border-t border-slate-200 px-4 py-12 text-center text-sm text-slate-500">
                No payments recorded yet. Connect your bank and send a rent request to get started.
              </div>
            )}
          </Card>

          <Card bodyClassName="p-4">
            <CardHeader
              title="Bank setup"
              subtitle={stripeAccountId ? 'Stripe connected — rent deposits to your linked account.' : 'Connect Stripe to collect rent online.'}
            />
            <LandlordBankSetup
              userId={ownerId || 'landlord-1'}
              userEmail={ownerEmail || 'landlord@example.com'}
              propertyId={propertyScopeId || propertyAddress}
            />
          </Card>
        </div>
      </div>
      )}

      {/* ── Listings ── */}
      {subTab === 'listings' && (
      <Card>
        <CardHeader
          title="Vacancy listings"
          subtitle="Post vacancies and track leads and showings."
          right={
            <button
              onClick={() => setShowCreateListing((l) => !l)}
              className="bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-blue-700"
            >
              {showCreateListing ? 'Cancel' : 'Create listing'}
            </button>
          }
        />

        <div className="space-y-4 border-t border-slate-200 p-4">
        {showCreateListing && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-sm font-semibold text-slate-900">New vacancy listing</div>
            <form onSubmit={handleCreateListing} className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-slate-600">Title</label>
                <input required value={newListing.title} onChange={(e) => setNewListing((p) => ({ ...p, title: e.target.value }))} placeholder="3BR/2BA Modern Apartment" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-slate-600">Description</label>
                <textarea rows={2} value={newListing.description} onChange={(e) => setNewListing((p) => ({ ...p, description: e.target.value }))} placeholder="Spacious unit with updated kitchen..." className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Monthly rent ($)</label>
                <input required type="number" value={newListing.price} onChange={(e) => setNewListing((p) => ({ ...p, price: e.target.value }))} placeholder="2500" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Sq ft</label>
                <input type="number" value={newListing.sqft} onChange={(e) => setNewListing((p) => ({ ...p, sqft: e.target.value }))} placeholder="950" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Bedrooms</label>
                <input type="number" value={newListing.bedrooms} onChange={(e) => setNewListing((p) => ({ ...p, bedrooms: e.target.value }))} placeholder="3" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Bathrooms</label>
                <input type="number" step="0.5" value={newListing.bathrooms} onChange={(e) => setNewListing((p) => ({ ...p, bathrooms: e.target.value }))} placeholder="2" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
              </div>
              <div className="sm:col-span-2 flex justify-end">
                <button type="submit" disabled={creatingListing} className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                  {creatingListing ? 'Creating…' : 'Publish listing'}
                </button>
              </div>
            </form>
          </div>
        )}

        {listings.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {listings.map((listing: any) => (
              <div key={listing.id} className="rounded-2xl border border-slate-200 p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-semibold text-slate-900 line-clamp-1">{listing.title || listing.address || 'Listing'}</div>
                  <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${listing.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                    {listing.status || 'draft'}
                  </span>
                </div>
                {listing.price != null && (
                  <div className="mt-2 text-lg font-bold text-slate-900">
                    ${Number(listing.price).toLocaleString()}<span className="text-sm font-normal text-slate-500">/mo</span>
                  </div>
                )}
                <div className="mt-2 flex gap-3 text-xs text-slate-500">
                  {listing.bedrooms && <span>{listing.bedrooms} bd</span>}
                  {listing.bathrooms && <span>{listing.bathrooms} ba</span>}
                  {listing.sqft && <span>{Number(listing.sqft).toLocaleString()} sqft</span>}
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-4 text-center text-xs text-slate-500">
                  <div><div className="font-semibold text-slate-900">{listing.viewCount || 0}</div><div>Views</div></div>
                  <div><div className="font-semibold text-slate-900">{listing.leadCount || 0}</div><div>Leads</div></div>
                  <div><div className="font-semibold text-slate-900">{listing.showingCount || 0}</div><div>Showings</div></div>
                </div>
                <div className="mt-4 flex gap-2">
                  <button
                    onClick={() => fetch(`/api/listings/${listing.id}/syndicate`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ platforms: ['facebook'] }),
                    })}
                    className="flex-1 rounded-xl border border-slate-200 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >Post to FB</button>
                  <button
                    onClick={() => fetch(`/api/listings/${listing.id}/leads`)}
                    className="flex-1 rounded-xl border border-slate-200 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                  >View Leads</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center">
            <div className="text-sm font-semibold text-slate-700">No listings yet</div>
            <div className="mt-1 text-xs text-slate-500">Create a listing to post your vacancy and track leads.</div>
            <button onClick={() => setShowCreateListing(true)} className="mt-3 text-xs font-semibold text-blue-600 hover:underline">Create first listing</button>
          </div>
        )}
        </div>
      </Card>
      )}

      {/* ── Payment Request Modal ── */}
      {showPaymentModal && (
        <div
          {...buildVoiceUiAttrs({
            id: 'property-management-payment-request-modal-overlay',
            label: 'Payment request modal overlay',
            type: 'section',
            description: 'Overlay for the payment request dialog.',
            pageSection: 'payments',
          })}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div
            {...buildVoiceUiAttrs({
              id: 'property-management-payment-request-modal',
              label: 'Payment request dialog',
              type: 'card',
              description: 'Dialog for sending a tenant payment request.',
              pageSection: 'payments',
            })}
            className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl"
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Send Payment Request</h3>
              <button
                onClick={() => setShowPaymentModal(false)}
                {...buildVoiceUiAttrs({
                  id: 'property-management-close-payment-request-btn',
                  label: 'Close payment request dialog',
                  type: 'button',
                  description: 'Dismiss the tenant payment request dialog.',
                  pageSection: 'payments',
                  interactive: true,
                })}
                className="text-slate-400 hover:text-slate-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="mb-4 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">Tenant Name</label>
                <input
                  value={paymentTenantName}
                  onChange={e => setPaymentTenantName(e.target.value)}
                  placeholder="Jane Smith"
                  {...buildVoiceUiAttrs({
                    id: 'property-management-payment-tenant-name-input',
                    label: 'Payment tenant name',
                    type: 'input',
                    description: 'Tenant name for the payment request.',
                    pageSection: 'payments',
                    interactive: true,
                  })}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">Tenant Email</label>
                <input
                  type="email"
                  value={paymentTenantEmail}
                  onChange={e => setPaymentTenantEmail(e.target.value)}
                  placeholder="tenant@email.com"
                  {...buildVoiceUiAttrs({
                    id: 'property-management-payment-tenant-email-input',
                    label: 'Payment tenant email',
                    type: 'input',
                    description: 'Tenant email for the payment request.',
                    pageSection: 'payments',
                    interactive: true,
                  })}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500"
                />
              </div>
            </div>
            <TenantPaymentForm
              landlordAccountId={stripeAccountId}
              tenantName={paymentTenantName || 'Tenant'}
              tenantEmail={paymentTenantEmail || ''}
              propertyAddress={propertyAddress}
              onPaymentComplete={() => setShowPaymentModal(false)}
            />
          </div>
        </div>
      )}

      {/* ── Onboarding Modal ── */}
      {showOnboarding && ownerId && (
        <TenantOnboardingModal
          isOpen={showOnboarding}
          onClose={() => setShowOnboarding(false)}
          propertyId={propertyScopeId || propertyAddress}
          propertyAddress={propertyAddress}
          ownerId={ownerId}
          ownerEmail={ownerEmail}
        />
      )}
    </div>
  );
}
function MaintenanceWorkspace({
  selectedProperty,
  ownerId,
  ownerEmail,
  ownerName,
  propertyScopeId,
}: {
  selectedProperty?: SavedProperty;
  ownerId?: string;
  ownerEmail?: string;
  ownerName?: string;
  propertyScopeId?: string;
}) {
  const [subTab, setSubTab] = useState<'new' | 'requests' | 'providers'>('requests');
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [useClassicForm, setUseClassicForm] = useState(false);
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  const [stats, setStats] = useState({
    open: 0,
    urgent: 0,
    awaitingApproval: 0,
    resolved: 0,
    total: 0,
  });
  const [scheduleRequests, setScheduleRequests] = useState<any[]>([]);

  const propertyAddress = selectedProperty?.address;

  const handleIntakeSubmitted = useCallback(() => {
    setLogRefreshKey((key) => key + 1);
    setSubTab('requests');
  }, []);

  const upcomingScheduleEvents = useMemo(() => {
    const now = Date.now() - 5 * 60 * 1000; // small grace window so "due now" events don't vanish immediately
    return buildScheduleEvents(scheduleRequests).filter((event) => event.date.getTime() >= now).slice(0, 8);
  }, [scheduleRequests]);

  return (
    <div
      {...buildVoiceUiAttrs({
        id: 'property-management-maintenance-panel',
        label: 'Maintenance workspace',
        type: 'section',
        description: 'Maintenance requests, provider selection, and phone call workflows.',
        pageSection: 'property-management-content',
      })}
      className="space-y-4"
    >
      <KpiStrip
        items={[
          { label: 'Open requests', value: String(stats.open), sub: 'Needs attention', active: subTab === 'requests' },
          { label: 'Urgent', value: String(stats.urgent), sub: 'Emergency or high priority', tone: stats.urgent > 0 ? 'negative' : 'default' },
          { label: 'Awaiting approval', value: String(stats.awaitingApproval), sub: 'Provider or owner action' },
          { label: 'Resolved', value: String(stats.resolved), sub: `${stats.total} total logged` },
        ]}
      />

      <SubTabs
        tabs={[
          { id: 'new', label: 'Report an issue', accent: 'violet' },
          { id: 'requests', label: 'Requests', accent: 'amber' },
          { id: 'providers', label: 'Providers', accent: 'sky' },
        ]}
        activeId={subTab}
        onChange={(id) => setSubTab(id as typeof subTab)}
      />

      {subTab === 'new' && (
        useClassicForm ? (
          <Card>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Classic request form</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  Pick a category and scenario instead of describing the issue.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUseClassicForm(false)}
                className="ds-focus-ring rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
              >
                Back to guided intake
              </button>
            </div>
            <MaintenanceRequestForm
              propertyAddress={propertyAddress}
              ownerId={ownerId}
              propertyId={propertyScopeId}
              onSubmitSuccess={handleIntakeSubmitted}
            />
          </Card>
        ) : (
          <MaintenanceIntakeFlow
            propertyAddress={propertyAddress}
            ownerId={ownerId}
            ownerEmail={ownerEmail}
            ownerName={ownerName}
            propertyId={propertyScopeId}
            submitterRole="owner"
            onSubmitted={handleIntakeSubmitted}
            onSwitchToForm={() => setUseClassicForm(true)}
          />
        )
      )}

      {subTab === 'requests' && (
        <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
          <Card flushBody>
            <MaintenanceRequestLog
              frameless
              maxItems={20}
              ownerId={ownerId}
              ownerEmail={ownerEmail}
              ownerName={ownerName}
              propertyId={propertyScopeId}
              onStatsChange={setStats}
              onRequestsChange={setScheduleRequests}
              refreshKey={logRefreshKey}
            />
          </Card>

          <Card flushBody>
            <CardHeader
              title="Upcoming schedule"
              subtitle="Confirmed visits and provider calls, soonest first."
            />
            <div className="max-h-[min(520px,58vh)] divide-y divide-slate-100 overflow-y-auto">
              {upcomingScheduleEvents.length === 0 ? (
                <div className="px-4 py-6 text-sm text-slate-500">
                  No upcoming visits or calls scheduled yet. Once a provider confirms a time, it will show up here automatically.
                </div>
              ) : (
                upcomingScheduleEvents.map((event) => (
                  <div key={event.id} className="flex items-start gap-3 px-4 py-3">
                    <div className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl text-sm ${event.type === 'visit' ? 'bg-emerald-50 text-emerald-600' : 'bg-indigo-50 text-indigo-600'}`}>
                      {event.type === 'visit' ? '🛠️' : '📞'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-slate-500">{formatAgendaDate(event.date)}</div>
                      <div className="mt-0.5 truncate text-sm font-medium text-slate-900">{event.title}</div>
                      <div className="mt-0.5 line-clamp-1 text-xs text-slate-500">
                        {event.request.propertyAddress || event.subtitle || 'Maintenance request'}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      )}

      {subTab === 'providers' && (
        <div className="space-y-4">
          <ProviderNetworkMap propertyAddress={propertyAddress} />
          <Card flushBody>
            <MaintenanceProviderHub
              propertyScopeId={propertyScopeId}
              propertyAddress={selectedProperty?.address}
              region={selectedProperty?.data?.summary?.area_context?.state_code || undefined}
            />
          </Card>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => setShowAdvancedTools((open) => !open)}
          className="ds-focus-ring flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50"
          aria-expanded={showAdvancedTools}
        >
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Advanced tools</div>
            <div className="mt-0.5 text-sm text-slate-600">Automated phone call workflow for maintenance follow-up.</div>
          </div>
          <svg
            className={`h-5 w-5 flex-shrink-0 text-slate-400 transition-transform ${showAdvancedTools ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showAdvancedTools && (
          <div className="border-t border-slate-200 p-4">
            <PhoneCallSystem
              maintenanceContext={{ propertyAddress: selectedProperty?.address }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function PropertyManagementPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const shellBookkeeping = useFirestoreBookkeeping();
  const bookkeepingRange = useMemo(() => getDefaultBookkeepingDateRange(), []);
  const [bookkeepingPanelTransactions, setBookkeepingPanelTransactions] = useState<ReturnType<typeof useFirestoreBookkeeping>['transactions'] | null>(null);
  const [savedProperties, setSavedProperties] = useState<SavedProperty[]>([]);
  const [connectedTenant, setConnectedTenant] = useState<any>(null);
  const [connectedTenants, setConnectedTenants] = useState<any[]>([]);
  const [serverPropertyId, setServerPropertyId] = useState<string | undefined>(undefined);

  const tabs = useMemo(() => getVisibleManagementTabs(), []);
  const defaultTab = getDefaultManagementTab();
  const pageLabel = getManagementNavLabel();
  const rawTab = searchParams.get('tab');
  const activeTab: ManagementTab = normalizeTab(rawTab) || defaultTab;
  const viewMode: ViewMode = searchParams.get('view') === 'combined' ? 'combined' : 'single';
  const selectedPropertyId = searchParams.get('property') || '';
  const addressQuery = String(searchParams.get('address') || '').trim();

  // Legacy deep link: bookkeeping is now a top-level sidebar page.
  useEffect(() => {
    if (rawTab !== 'bookkeeping') return;
    const next = new URLSearchParams();
    if (selectedPropertyId) next.set('property', selectedPropertyId);
    if (addressQuery) next.set('address', addressQuery);
    const query = next.toString();
    navigate(query ? `/bookkeeping?${query}` : '/bookkeeping', { replace: true });
  }, [rawTab, selectedPropertyId, addressQuery, navigate]);

  const setManagementTab = useCallback((tab: ManagementTab) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', normalizeManagementTab(tab) || defaultTab);
    setSearchParams(nextParams);
  }, [defaultTab, searchParams, setSearchParams]);

  const normalizePropertyAddress = useCallback((value: string) => (
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  ), []);

  const scorePropertyAddressMatch = useCallback((candidate: string, needle: string) => {
    const left = normalizePropertyAddress(candidate);
    const right = normalizePropertyAddress(needle);
    if (!left || !right) return 0;
    if (left === right) return 100;
    if (left.includes(right) || right.includes(left)) return 80;
    const leftTokens = left.split(' ').filter(Boolean);
    const rightTokens = right.split(' ').filter(Boolean);
    const leftNumber = leftTokens.find((token) => /^\d+[a-z]?$/.test(token));
    const rightNumber = rightTokens.find((token) => /^\d+[a-z]?$/.test(token));
    // Street numbers must agree when both sides have one (11822 vs 11825).
    if (leftNumber && rightNumber && leftNumber !== rightNumber) return 0;
    const overlap = rightTokens.filter((token) => leftTokens.includes(token)).length;
    if (overlap < Math.min(2, rightTokens.length)) return 0;
    return overlap * 10 + (leftNumber && rightNumber ? 20 : 0);
  }, [normalizePropertyAddress]);

  const openDocumentsWorkspace = useCallback(() => {
    if (isMaintenanceProduct()) {
      setManagementTab('maintenance');
      return;
    }
    setManagementTab('documents');
  }, [setManagementTab]);

  const openDocumentUpload = useCallback(() => {
    if (isMaintenanceProduct()) {
      setManagementTab('maintenance');
      return;
    }
    setManagementTab('documents');
    window.setTimeout(() => {
      const uploadTarget = document.querySelector('.upload-dropzone');
      if (uploadTarget instanceof HTMLElement) {
        uploadTarget.click();
      }
    }, 250);
  }, [setManagementTab]);

  const openCreateLeaseAgreement = useCallback(async (params?: Record<string, any>) => {
    if (isMaintenanceProduct()) {
      setManagementTab('maintenance');
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', 'documents');
    if (params?.propertyId) {
      nextParams.set('property', String(params.propertyId));
      nextParams.delete('address');
    } else if (params?.propertyAddress || params?.address || params?.location) {
      nextParams.set('address', String(params.propertyAddress || params.address || params.location));
    }
    if (params?.documentId) {
      nextParams.set('documentId', String(params.documentId));
    }
    setSearchParams(nextParams);

    const payload = {
      action: 'create-lease-agreement',
      documentType: params?.documentType || params?.document_type || 'LEASE_AGREEMENT',
      propertyId: params?.propertyId,
      propertyAddress: params?.propertyAddress || params?.address || params?.location,
      tenantId: params?.tenantId,
      customInstructions: params?.customInstructions,
      requestSummary: params?.requestSummary,
      autoGenerate: params?.autoGenerate !== false,
      createdAt: Date.now(),
    };

    window.sessionStorage.setItem('houseyield:document-action', JSON.stringify(payload));

    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        window.removeEventListener('houseyield:document-action-complete', onComplete);
        reject(new Error('Document generation timed out after two minutes.'));
      }, 120000);

      const onComplete = (event: Event) => {
        const detail = (event as CustomEvent<{ action?: string; success?: boolean; error?: string }>).detail;
        if (detail?.action !== 'create-lease-agreement') {
          return;
        }

        window.clearTimeout(timeout);
        window.removeEventListener('houseyield:document-action-complete', onComplete);

        if (detail.success) {
          resolve();
          return;
        }

        reject(new Error(detail.error || 'Document generation failed.'));
      };

      window.addEventListener('houseyield:document-action-complete', onComplete);

      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('houseyield:document-action', {
          detail: payload,
        }));
      }, 500);
    });
  }, [searchParams, setManagementTab, setSearchParams]);

  const openMaintenanceWorkspace = useCallback(() => {
    setManagementTab('maintenance');
  }, [setManagementTab]);

  const openTenantsWorkspace = useCallback(() => {
    setManagementTab(isMaintenanceProduct() ? 'maintenance' : 'tenants');
  }, [setManagementTab]);

  const openBookkeepingWorkspace = useCallback(() => {
    const next = new URLSearchParams();
    if (selectedPropertyId) next.set('property', selectedPropertyId);
    const query = next.toString();
    navigate(query ? `/bookkeeping?${query}` : '/bookkeeping');
  }, [navigate, selectedPropertyId]);

  const openTaxWorkspace = useCallback(() => {
    if (isMaintenanceProduct()) {
      openBookkeepingWorkspace();
      return;
    }
    setManagementTab('tax');
  }, [openBookkeepingWorkspace, setManagementTab]);

  useVoiceActionHandler('property-management-documents-tab', openDocumentsWorkspace, [openDocumentsWorkspace]);
  useVoiceActionHandler('upload-document', openDocumentUpload, [openDocumentUpload]);
  useVoiceActionHandler('create-lease-agreement', openCreateLeaseAgreement, [openCreateLeaseAgreement]);
  useVoiceActionHandler('create-document', openCreateLeaseAgreement, [openCreateLeaseAgreement]);
  useVoiceActionHandler('open-maintenance-modal', openMaintenanceWorkspace, [openMaintenanceWorkspace]);
  useVoiceActionHandler('property-management-maintenance-tab', openMaintenanceWorkspace, [openMaintenanceWorkspace]);
  useVoiceActionHandler('property-management-tenants-tab', openTenantsWorkspace, [openTenantsWorkspace]);
  useVoiceActionHandler('view-tenants', openTenantsWorkspace, [openTenantsWorkspace]);
  useVoiceActionHandler('property-management-bookkeeping-tab', openBookkeepingWorkspace, [openBookkeepingWorkspace]);
  useVoiceActionHandler('property-management-tax-tab', openTaxWorkspace, [openTaxWorkspace]);
  useVoiceActionHandler('view-maintenance', openMaintenanceWorkspace, [openMaintenanceWorkspace]);

  useEffect(() => {
    if (rawTab !== 'tax-center') return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', 'tax');
    setSearchParams(nextParams, { replace: true });
  }, [rawTab, searchParams, setSearchParams]);

  // Load properties from the canonical owner-properties store so every Property Management
  // tab resolves against the same Firestore-backed IDs and payloads.
  useEffect(() => {
    let cancelled = false;

    const loadProperties = async () => {
      if (!user?.id) {
        setSavedProperties(getSavedProperties());
        return;
      }

      try {
        const serverProps = await ownerPropertiesClient.list(user.id);
        if (!cancelled) {
          setSavedProperties(serverProps);
        }
      } catch (err) {
        console.error('[PropertyMgmt] Failed to load canonical owner properties:', err);
        if (!cancelled) {
          setSavedProperties([]);
        }
      }
    };

    loadProperties();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Resolve ?address= from the assistant (e.g. "11822 Prestwick") into ?property=
  // BEFORE falling back to the first property — otherwise the page stays on 11825 while
  // the task pad works on 11822.
  useEffect(() => {
    if (savedProperties.length === 0) return;

    if (addressQuery) {
      const ranked = savedProperties
        .map((property) => ({
          property,
          score: scorePropertyAddressMatch(property.address || '', addressQuery),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);

      const best = ranked[0]?.property;
      if (best && best.id !== selectedPropertyId) {
        const nextParams = new URLSearchParams(searchParams);
        nextParams.set('property', best.id);
        nextParams.delete('address');
        setSearchParams(nextParams, { replace: true });
        return;
      }
      if (best) {
        // Address already resolved to the active property — drop the redundant param.
        if (searchParams.has('address')) {
          const nextParams = new URLSearchParams(searchParams);
          nextParams.delete('address');
          setSearchParams(nextParams, { replace: true });
        }
        return;
      }
    }

    const matchExists = savedProperties.some((p) => p.id === selectedPropertyId);
    if (matchExists) return;
    // Don't clobber an in-flight address resolve with the first property.
    if (addressQuery) return;

    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('property', savedProperties[0].id);
    setSearchParams(nextParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedProperties, selectedPropertyId, addressQuery, scorePropertyAddressMatch, setSearchParams]);

  const selectedProperty = useMemo(
    () => savedProperties.find((property) => property.id === selectedPropertyId) || savedProperties[0],
    [savedProperties, selectedPropertyId]
  );

  // Fetch the connected tenant from the server whenever the selected property changes.
  // Since savedProperties now use server-format IDs, we can match exactly by ID.
  useEffect(() => {
    if (!user?.id || !selectedProperty) {
      setConnectedTenant(null);
      setConnectedTenants([]);
      setServerPropertyId(undefined);
      return;
    }

    const fetchConnectedTenant = async () => {
      try {
        const properties = await ownerPropertiesClient.listDetailed(user.id, { withTenants: true });

        // Exact ID match — works because savedProperties now use the same server IDs
        const match = properties.find((property) => property.id === selectedProperty.id);

        if (match) {
          setServerPropertyId(match.id);
          const allTenants: any[] = match.tenants || (match.tenant ? [match.tenant] : []);
          setConnectedTenants(allTenants);
          setConnectedTenant(allTenants[0] ?? null);
        } else {
          setServerPropertyId(undefined);
          setConnectedTenant(null);
          setConnectedTenants([]);
        }
      } catch (err) {
        console.error('[PropertyMgmt] Failed to fetch connected tenant:', err);
      }
    };

    fetchConnectedTenant();
  }, [selectedProperty?.id, user?.id]);

  // Prefer the server's authoritative property ID so child components (TenantActivityPanel,
  // DocumentManager, etc.) use the same ID that was stored when the tenant was onboarded.
  const propertyScopeId = viewMode === 'single' ? (serverPropertyId ?? buildPropertyScopeId(user?.id, selectedProperty)) : undefined;
  const financeTabActive = activeTab === 'tax';
  const activeTabDefinition = tabs.find((tab) => tab.id === activeTab) || tabs[0];
  const shellFinanceUser = shellBookkeeping.user;
  const shellFinanceInitialized = shellBookkeeping.isInitialized;
  const shellFinanceTransactions = shellBookkeeping.transactions;
  const fetchShellBookkeepingData = shellBookkeeping.fetchData;
  const initializeShellBookkeeping = shellBookkeeping.initialize;
  const refreshShellFinanceSnapshot = useCallback(() => {
    if (!shellFinanceUser || !shellFinanceInitialized) {
      return Promise.resolve();
    }

    return fetchShellBookkeepingData(
      propertyScopeId
        ? { ...bookkeepingRange, propertyId: propertyScopeId }
        : bookkeepingRange,
    );
  }, [
    bookkeepingRange,
    fetchShellBookkeepingData,
    propertyScopeId,
    shellFinanceInitialized,
    shellFinanceUser,
  ]);

  useEffect(() => {
    setBookkeepingPanelTransactions(null);
  }, [activeTab, propertyScopeId]);

  useEffect(() => {
    if (!financeTabActive || !shellFinanceUser) return;

    if (!shellFinanceInitialized) {
      initializeShellBookkeeping();
      return;
    }

    fetchShellBookkeepingData(
      propertyScopeId
        ? { ...bookkeepingRange, propertyId: propertyScopeId }
        : bookkeepingRange,
    );
  }, [bookkeepingRange, fetchShellBookkeepingData, financeTabActive, initializeShellBookkeeping, propertyScopeId, shellFinanceInitialized, shellFinanceUser]);

  const financeScopeTransactions = bookkeepingPanelTransactions ?? shellFinanceTransactions;

  const financeSourceMix = useMemo(
    () => buildFinanceSourceMix(financeScopeTransactions),
    [financeScopeTransactions],
  );
  const shellFinanceSummary = useMemo(
    () => buildSummary(financeScopeTransactions),
    [financeScopeTransactions],
  );
  const shellExpenseCategories = useMemo(
    () => buildExpenseCategories(financeScopeTransactions).slice(0, 3),
    [financeScopeTransactions],
  );

  const updateParam = (key: string, value: string) => {
    const nextParams = new URLSearchParams(searchParams);
    const nextValue = key === 'tab' ? (normalizeManagementTab(value) || defaultTab) : value;
    nextParams.set(key, nextValue);
    setSearchParams(nextParams);
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'documents':
        return <DocumentManager ownerId={user?.id} propertyId={propertyScopeId} />;
      case 'tenants':
        if (!user?.id) {
          return <div className="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">Sign in as an owner to view tenant activity.</div>;
        }
        return <TenantWorkspace ownerId={user.id} ownerEmail={user.email} propertyScopeId={propertyScopeId} selectedProperty={selectedProperty} connectedTenant={connectedTenant} connectedTenants={connectedTenants} />;
      case 'maintenance':
        return <MaintenanceWorkspace selectedProperty={selectedProperty} ownerId={user?.id} ownerEmail={user?.email} ownerName={user?.name} propertyScopeId={propertyScopeId} />;
      case 'tax':
        return (
          <TaxPanel
            propertyId={propertyScopeId}
            propertyAddress={selectedProperty?.address}
          />
        );
      default:
        return null;
    }
  };

  const pinnedHeader = (
    <div className="px-6 pt-4">
      <div className="mx-auto max-w-7xl">
        <WorkspaceTabsHeader
          eyebrow={pageLabel}
          contentClassName="max-w-7xl"
          activeTab={activeTab}
          onTabChange={(tab) => updateParam('tab', normalizeManagementTab(tab) || defaultTab)}
          tabs={tabs.map((tab) => ({
            id: tab.id,
            label: tab.label,
            description: tab.description,
            buttonProps: buildVoiceUiAttrs({
              id: `property-management-${tab.id}-tab`,
              label: `${tab.label} tab`,
              type: 'tab',
              description: tab.description,
              pageSection: 'property-management-tabs',
              interactive: true,
            }),
          }))}
          sectionProps={buildVoiceUiAttrs({
            id: 'property-management-header',
            label: `${pageLabel} header`,
            type: 'section',
            description: `Property scope selector and navigation tabs for the ${pageLabel.toLowerCase()} workspace.`,
            pageSection: 'property-management-header',
          })}
          tabsWrapperProps={buildVoiceUiAttrs({
            id: 'property-management-tabs',
            label: `${pageLabel} tabs`,
            type: 'section',
            description: isMaintenanceProduct()
              ? 'Maintenance orchestration workspace.'
              : 'Switch between documents, tenants, maintenance, and tax workspaces.',
            pageSection: 'property-management-header',
          })}
          rightContent={
            <div className="w-full max-w-sm sm:w-[340px]">
              <label className="block">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500 sm:justify-end">
                  <Home size={12} className="text-slate-400" />
                  Viewing property
                </div>
                <div className="relative">
                  <select
                    value={selectedProperty?.id || ''}
                    onChange={(event) => updateParam('property', event.target.value)}
                    {...buildVoiceUiAttrs({
                      id: 'property-management-property-select',
                      label: 'Property selector',
                      type: 'input',
                      description: 'Choose the property scope for the management workspace.',
                      pageSection: 'property-management-header',
                      interactive: true,
                    })}
                    className="ds-focus-ring w-full appearance-none rounded-2xl border-2 border-slate-300 bg-white px-4 py-3 pr-10 text-[15px] font-semibold text-slate-900 shadow-sm outline-none transition hover:border-slate-400 focus:border-slate-500"
                  >
                    {savedProperties.length === 0 && <option value="">No saved properties yet</option>}
                    {savedProperties.map((property) => (
                      <option key={property.id} value={property.id}>{property.address}</option>
                    ))}
                  </select>
                  <ChevronDown size={18} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                </div>
              </label>
            </div>
          }
        />
      </div>
    </div>
  );

  return (
    <PageShell header={pinnedHeader} className="flex-1" contentClassName="space-y-6">
      <div
        {...buildVoiceUiAttrs({
          id: 'property-management-page',
          label: `${pageLabel} page`,
          type: 'section',
          description: isMaintenanceProduct()
            ? 'Maintenance orchestration workspace for requests, providers, and repair status.'
            : 'Property operations workspace with documents, tenants, maintenance, and tax tabs.',
          pageSection: 'property-management-root',
        })}
        className="space-y-6"
      >

        {financeTabActive && (
          <div className="space-y-4">
            <FinanceSourceTruthBanner
              sourceMix={financeSourceMix}
              scopeLabel={selectedProperty?.address || 'Portfolio finance scope'}
              note="Ledger analytics, tax tie-outs, and exports use one canonical source mix for this property."
              compact
            />

            <Card flushBody>
              <KpiStrip
                items={[
                  {
                    label: 'Income',
                    value: formatCurrency(shellFinanceSummary.totalIncome),
                    sub: 'Posted income in scope',
                  },
                  {
                    label: 'Expenses',
                    value: formatCurrency(shellFinanceSummary.totalExpenses),
                    sub: 'Posted expenses in scope',
                  },
                  {
                    label: 'Net cash flow',
                    value: formatCurrency(shellFinanceSummary.netCashFlow),
                    sub: shellFinanceSummary.totalIncome > 0 ? `${shellFinanceSummary.margin}% margin` : 'No income posted yet',
                    tone: shellFinanceSummary.netCashFlow > 0 ? 'positive' : shellFinanceSummary.netCashFlow < 0 ? 'negative' : 'default',
                  },
                  {
                    label: 'Data source',
                    value: financeSourceMix.total === 0 ? 'No data yet' : financeSourceMix.hasSample ? `${financeSourceMix.samplePct}% sample` : 'Live only',
                    sub:
                      financeSourceMix.total === 0
                        ? 'No finance entries in scope'
                        : financeSourceMix.hasSample
                          ? `${financeSourceMix.livePct}% live/manual mix`
                          : 'No sample data in scope',
                  },
                ]}
              />
              {shellExpenseCategories.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Top expenses</span>
                  {shellExpenseCategories.map((category) => (
                    <span key={category.name} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-700">
                      {category.name} · {formatCurrency(category.amount)}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}

        <div
          {...buildVoiceUiAttrs({
            id: `property-management-${activeTab}-content`,
            label: `${activeTabDefinition.label} workspace`,
            type: 'section',
            description: activeTabDefinition.description,
            pageSection: 'property-management-content',
          })}
        >
          {renderContent()}
        </div>
      </div>
    </PageShell>
  );
}
