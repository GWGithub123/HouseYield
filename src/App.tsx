import React, { useState, useEffect, Suspense } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate, useSearchParams } from 'react-router-dom';

import { AuthProvider, useAuth } from './contexts/AuthContext';
import { VoiceCommandProvider } from './contexts/VoiceCommandContext';
import { AssistantActivityProvider } from './contexts/AssistantActivityContext';
import { getAssets } from './services/portfolioService';
import { subscribeToPush, sendTestPush, unsubscribeFromPush } from './services/pushNotifications';
import OwnerProfileContactSettings from './components/OwnerProfileContactSettings';
import WeeklyRecapSettingsCard from './components/WeeklyRecapSettingsCard';
import { ownerPropertiesClient } from './services/ownerPropertiesClient';
import { buildOwnerFinanceUrl } from './services/ownerFinanceApi';
import AboutPage from './pages/AboutPage';
import LoginSelection from './pages/LoginSelection';
import OwnerLogin from './pages/OwnerLogin';
import OwnerSignup from './pages/OwnerSignup';
import OwnerOnboarding from './pages/OwnerOnboarding';
import TenantLogin from './pages/TenantLogin';
import TenantSignup from './pages/TenantSignup';
import TenantMaintenanceLivePage from './pages/TenantMaintenanceLivePage';
import PaymentReceipt from './pages/PaymentReceipt';
import AutoPayReceipt from './pages/AutoPayReceipt';
import PropertyManagementPage from './pages/PropertyManagementPage';
import BookkeepingPage from './pages/BookkeepingPage';
import DocumentScanner from './pages/DocumentScanner';
import DocumentSigning from './pages/DocumentSigning';
import SensorDashboard from './components/SensorDashboard';
import ShellySetupWizard from './components/ShellySetupWizard';
import { VoiceAISupportLiveKit as VoiceAISupport } from './components/VoiceAISupportLiveKit';
import TopHeader from './components/TopHeader';
import LeaseBuilder from './components/LeaseBuilder';
import SidebarLiquidGlassShell from './components/SidebarLiquidGlassShell';
import { buildCanonicalPortfolioProjection } from './services/canonicalPortfolioService';
import { DesignSystemShowcase } from './design-system';
import {
  getDefaultOwnerHomePath,
  getManagementNavLabel,
  isSidebarNavItemEnabled,
} from './product/productMode';

const PortfolioPage = React.lazy(() => import('./pages/PortfolioPage'));

/* -------------------- SHARED LAYOUT -------------------- */

const SIDEBAR_HIGHLIGHT_ROTATE_MS = 6000;

const Sidebar = () => {
  const { user } = useAuth();
  const [totalPropertyValue, setTotalPropertyValue] = useState<number | null>(null);
  const [propertyCount, setPropertyCount] = useState<number | null>(null);
  const [recentTenantMessages, setRecentTenantMessages] = useState<number | null>(null);
  const [unreadTenantMessages, setUnreadTenantMessages] = useState<number>(0);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let isActive = true;

    if (!user?.id) {
      setTotalPropertyValue(null);
      setPropertyCount(null);
      setRecentTenantMessages(null);
      setUnreadTenantMessages(0);
      return () => {
        isActive = false;
      };
    }

    void (async () => {
      // Canonical source first: owner properties drive the same $ totals shown
      // on the Dashboard/Properties pages. Manual portfolio assets are only a
      // fallback so the sidebar never disagrees with the app body.
      try {
        const [ownerProperties, manualAssets] = await Promise.all([
          ownerPropertiesClient.listDetailed(user.id, { withTenants: true }).catch(() => []),
          getAssets(user.id).catch(() => null),
        ]);
        if (!isActive) return;

        const projection = buildCanonicalPortfolioProjection({
          ownerProperties,
          manualRealEstateAssets: manualAssets?.realEstate || [],
          manualLiabilities: [],
        });
        const realEstateAssets = projection.realEstateAssets;
        const total = realEstateAssets.reduce((sum, asset) => sum + (asset.value || 0), 0);
        setTotalPropertyValue(total);
        setPropertyCount(realEstateAssets.length);

        const messageCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        let recentMessageCount = 0;
        let unreadMessageCount = 0;
        try {
          const response = await fetch(
            buildOwnerFinanceUrl(`/api/owner/messages?ownerId=${encodeURIComponent(user.id)}`),
          );
          const payload = await response.json().catch(() => ({}));
          const messages = Array.isArray(payload?.messages) ? payload.messages : [];
          recentMessageCount = messages.filter((message: { createdAt?: string }) => {
            const created = message?.createdAt ? new Date(message.createdAt).getTime() : NaN;
            return Number.isFinite(created) && created >= messageCutoff;
          }).length;
          unreadMessageCount = Number.isFinite(Number(payload?.totalUnread))
            ? Number(payload.totalUnread)
            : 0;
        } catch {
          recentMessageCount = 0;
          unreadMessageCount = 0;
        }
        if (!isActive) return;
        setRecentTenantMessages(recentMessageCount);
        setUnreadTenantMessages(unreadMessageCount);
      } catch {
        if (!isActive) return;
        setTotalPropertyValue(null);
        setPropertyCount(null);
        setRecentTenantMessages(null);
        setUnreadTenantMessages(0);
      }
    })();

    return () => {
      isActive = false;
    };
  }, [user?.id]);

  const formatSidebarCurrency = (value: number) => {
    if (value >= 1_000_000) {
      return `$${(value / 1_000_000).toFixed(2)}MM`;
    }
    if (value >= 1_000) {
      return `$${(value / 1_000).toFixed(1)}K`;
    }
    return `$${Math.round(value).toLocaleString()}`;
  };

  const sidebarHighlights = [
    {
      id: 'value',
      label: 'Total Property Value',
      value: totalPropertyValue !== null ? formatSidebarCurrency(totalPropertyValue) : '—',
    },
    {
      id: 'properties',
      label: 'Properties',
      value: propertyCount !== null ? `${propertyCount}` : '—',
    },
    {
      id: 'messages',
      label: 'Tenant Messages',
      value: recentTenantMessages !== null ? `${recentTenantMessages} this week` : '—',
    },
  ];
  const activeHighlight = sidebarHighlights[highlightIndex % sidebarHighlights.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setHighlightIndex((current) => (current + 1) % sidebarHighlights.length);
    }, SIDEBAR_HIGHLIGHT_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [sidebarHighlights.length]);

  const base = "block rounded-lg border border-white/10 px-3 py-2 text-sm text-white/85 bg-[#1a3a5c]/50 hover:bg-[#2a5080]/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 transition-colors backdrop-blur-sm";
  const active = " bg-[#3b6ea8] text-white border-white/40 shadow-inner ring-2 ring-white/30";
  const sectionLabel = "mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-white/55";
  const sectionDivider = "border-t-[0.5px] border-white/8 pt-4";
  return (
    <>
      <button
        type="button"
        className="fixed left-3 top-3 z-[60] inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-900 shadow-lg lg:hidden"
        aria-label={mobileOpen ? 'Close navigation' : 'Open navigation and assistant'}
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((open) => !open)}
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          {mobileOpen ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          )}
        </svg>
      </button>
      {mobileOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-[55] bg-slate-950/45 lg:hidden"
          aria-label="Close navigation overlay"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}
      <aside
        className={`w-65 shrink-0 h-screen bg-[#0d1f33] flex flex-col text-white overflow-hidden p-2.5 transition-transform duration-200 motion-reduce:transition-none ${
          mobileOpen
            ? 'fixed inset-y-0 left-0 z-[56] translate-x-0 shadow-2xl lg:static lg:translate-x-0'
            : 'fixed inset-y-0 left-0 z-[56] -translate-x-full lg:static lg:translate-x-0'
        }`}
        data-voice-id="sidebar"
      >
      <SidebarLiquidGlassShell className="flex-1 flex flex-col min-h-0" contentClassName="flex h-full flex-col min-h-0 overflow-hidden">
          <div className="p-3 flex-shrink-0">
            <div className="mb-2.5 flex items-center justify-between">
              <div className="rounded-xl border border-white/25 px-2.5 py-1.5 text-sm font-bold text-white leading-tight bg-[#1a4070]/70 shadow-sm backdrop-blur-sm">
                HouseYield
              </div>
              <NavLink to="/profile" onClick={() => setMobileOpen(false)} className={({isActive}) => "rounded-lg border border-white/15 p-2 bg-[#1a3a5c]/50 hover:bg-[#2a5080]/60 hover:text-white transition-colors backdrop-blur-sm" + (isActive ? " bg-[#3b6ea8] border-white/40 shadow-inner ring-2 ring-white/30" : "")}>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </NavLink>
            </div>
            <nav className="space-y-4" data-voice-id="main-nav" onClick={() => setMobileOpen(false)}>
              {isSidebarNavItemEnabled('dashboard') ? (
                <div className="space-y-1.5">
                  <NavLink to="/dashboard" className={({isActive}) => base + (isActive ? active : "")} data-voice-id="nav-dashboard">Dashboard</NavLink>
                </div>
              ) : null}

              {isSidebarNavItemEnabled('market-insights') ? (
                <div>
                  <div className={sectionLabel}>Analysis</div>
                  <div className="space-y-1.5">
                    <NavLink to="/market-data" className={({isActive}) => base + (isActive ? active : "")} data-voice-id="nav-market-data">Market Insights</NavLink>
                  </div>
                </div>
              ) : null}

              <div className={sectionDivider}>
                <div className={sectionLabel}>Real Estate</div>
                <div className="space-y-1.5">
                  {isSidebarNavItemEnabled('properties') ? (
                    <NavLink to="/portfolio" className={({isActive}) => base + (isActive ? active : "")} data-voice-id="nav-portfolio">Properties</NavLink>
                  ) : null}
                  {isSidebarNavItemEnabled('management') ? (
                    <NavLink to="/property-management" className={({isActive}) => base + (isActive ? active : "")} data-voice-id="nav-property-management">{getManagementNavLabel()}</NavLink>
                  ) : null}
                  {isSidebarNavItemEnabled('bookkeeping') ? (
                    <NavLink to="/bookkeeping" className={({isActive}) => base + (isActive ? active : "")} data-voice-id="nav-bookkeeping">Bookkeeping</NavLink>
                  ) : null}
                  {isSidebarNavItemEnabled('predictive-maintenance') ? (
                    <NavLink to="/sensors" className={({isActive}) => base + (isActive ? active : "")} data-voice-id="nav-sensors">Predictive Maintenance</NavLink>
                  ) : null}
                </div>
              </div>

            </nav>
          </div>

          {/* Bottom stack: Support can scroll; Highlights stay pinned and visible */}
          <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 pt-1">
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-0.5">
              <div className={sectionLabel}>Support</div>
              <div className="mb-3 rounded-2xl border border-white/15 p-1.5">
                <VoiceAISupport />
              </div>
            </div>

            <div className="shrink-0 pt-1">
              <div className={sectionLabel}>Highlights</div>
              <button
                type="button"
                onClick={() => setHighlightIndex((current) => (current + 1) % sidebarHighlights.length)}
                className="w-full rounded-xl border border-white/15 p-2.5 bg-[#1a3a5c]/60 backdrop-blur-sm text-left transition-colors hover:bg-[#2a5080]/50"
                aria-label={`Highlight: ${activeHighlight.label}. Tap to see the next highlight.`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-xs text-white/70">{activeHighlight.label}</div>
                    <div className="truncate text-base font-bold text-white">{activeHighlight.value}</div>
                  </div>
                  {unreadTenantMessages > 0 ? (
                    <span
                      className="inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-red-500/30 text-red-200 text-xs font-semibold"
                      title={`${unreadTenantMessages} unread tenant message${unreadTenantMessages === 1 ? '' : 's'}`}
                    >
                      {unreadTenantMessages}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  {sidebarHighlights.map((highlight, index) => (
                    <span
                      key={highlight.id}
                      className={`h-1 rounded-full transition-all ${
                        index === highlightIndex % sidebarHighlights.length
                          ? 'w-4 bg-white/80'
                          : 'w-1.5 bg-white/25'
                      }`}
                    />
                  ))}
                </div>
              </button>
            </div>
          </div>
      </SidebarLiquidGlassShell>
    </aside>
    </>
  );
};

/* -------------------- PROFILE PAGE -------------------- */
const ProfilePage = () => {
  const vapidMissing = !import.meta.env.VITE_VAPID_PUBLIC_KEY;
  const [pushLoading, setPushLoading] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState<boolean | null>(null);
  const [pushMsg, setPushMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        setIsSubscribed(!!sub);
      } catch {
        setIsSubscribed(false);
      }
    })();
  }, []);

  return (
    <div className="flex flex-col w-full h-screen" data-voice-id="profile-page">
      <TopHeader>
        <div className="flex items-center gap-3 w-full">
          <div className="text-lg font-medium">Profile</div>
        </div>
      </TopHeader>
      <main className="flex-1 p-6 overflow-auto" data-voice-id="profile-content">
        <div className="max-w-3xl">
          <OwnerProfileContactSettings />

          <WeeklyRecapSettingsCard />

          <div className="rounded-xl border bg-white p-5 mb-6" data-voice-id="notification-settings">
            <div className="text-base font-semibold mb-3">Notification Settings</div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <button
                className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-100"
                disabled={pushLoading || vapidMissing}
                data-voice-id="subscribe-notifications-btn"
                onClick={async () => {
                  setPushMsg(null);
                  setPushLoading(true);
                  try {
                    const result = await subscribeToPush(undefined);
                    if (result.ok) {
                      setIsSubscribed(true);
                      setPushMsg('Notifications enabled');
                    } else {
                      setIsSubscribed(false);
                      setPushMsg(result.reason);
                    }
                  } finally {
                    setPushLoading(false);
                  }
                }}
              >
                {pushLoading ? 'Working…' : isSubscribed ? 'Enabled' : 'Subscribe to Notifications'}
              </button>
              <button
                className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-100"
                disabled={pushLoading || vapidMissing}
                data-voice-id="send-test-notification-btn"
                onClick={async () => {
                  setPushMsg(null);
                  setPushLoading(true);
                  try {
                    const res = await sendTestPush(undefined, { title: 'Test', body: 'Hello from push', data: { url: '/' } });
                    setPushMsg(res.ok ? `Test sent (${res.count ?? 'n/a'} recipients)` : (res.reason || 'Failed to send test'));
                  } finally {
                    setPushLoading(false);
                  }
                }}
              >
                Send Test Notification
              </button>
              {isSubscribed && (
                <button
                  className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-100"
                  disabled={pushLoading}
                  data-voice-id="disable-notifications-btn"
                  onClick={async () => {
                    setPushMsg(null);
                    setPushLoading(true);
                    try {
                      const ok = await unsubscribeFromPush(undefined);
                      setIsSubscribed(!ok ? true : false);
                      setPushMsg(ok ? 'Notifications disabled' : 'Could not unsubscribe');
                    } finally {
                      setPushLoading(false);
                    }
                  }}
                >
                  Disable
                </button>
              )}
            </div>
            {pushMsg && (
              <div className="text-xs text-gray-600">{pushMsg}</div>
            )}
            {!pushMsg && vapidMissing && (
              <div className="text-xs text-rose-600">Missing VAPID public key</div>
            )}
            <div className="text-xs text-gray-500 mt-2">
              Status: {isSubscribed === null ? 'Checking…' : isSubscribed ? 'Enabled' : 'Disabled'}
            </div>
          </div>
        </div>
      </main>

      {/* (Removed misplaced modal; correct overlay lives within PortfolioPage) */}
    </div>
  );
};
/* -------------------- PLACEHOLDERS -------------------- */
// Placeholder component removed - unused

// Payment Success Page
const PaymentSuccessPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const [paymentStatus, setPaymentStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (sessionId) {
      fetch(`http://localhost:3001/api/tenant-payment/status/${sessionId}`)
        .then(res => res.json())
        .then(data => {
          setPaymentStatus(data);
          setLoading(false);
        })
        .catch(err => {
          console.error('Error fetching payment status:', err);
          setLoading(false);
        });
    }
  }, [sessionId]);

  return (
    <div className="flex flex-col w-full h-screen">
      <TopHeader>
        <div className="rounded-lg border px-4 py-2 inline-block">Payment Success</div>
      </TopHeader>
      <main className="flex-1 p-6 flex items-center justify-center">
        <div className="max-w-2xl w-full bg-white rounded-xl shadow-lg p-8 text-center">
          {loading ? (
            <div className="animate-pulse">
              <div className="h-16 w-16 bg-green-100 rounded-full mx-auto mb-4"></div>
              <div className="h-4 bg-gray-200 rounded w-3/4 mx-auto"></div>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <svg className="h-16 w-16 text-green-500 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h1 className="text-3xl font-bold text-gray-900 mb-4">Payment Successful!</h1>
              <p className="text-gray-600 mb-6">
                Your rent payment has been processed successfully.
              </p>
              {paymentStatus && (
                <div className="bg-gray-50 rounded-lg p-4 mb-6 text-left">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-sm text-gray-500">Amount Paid</p>
                      <p className="font-semibold">${(paymentStatus.amount_total / 100).toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-sm text-gray-500">Status</p>
                      <p className="font-semibold capitalize">{paymentStatus.payment_status}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-sm text-gray-500">Payment ID</p>
                      <p className="font-mono text-xs">{sessionId}</p>
                    </div>
                  </div>
                </div>
              )}
              <button
                onClick={() => navigate('/portfolio')}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Return to Portfolio
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
};

// Protected Route Component
const ProtectedRoute = ({ children, requiredRole, allowToken = false, skipOnboardingGate = false }: { children: React.ReactNode; requiredRole?: 'owner' | 'tenant' | 'contractor'; allowToken?: boolean; skipOnboardingGate?: boolean }) => {
  const { user, isAuthenticated, loading } = useAuth();
  const [searchParams] = useSearchParams();
  const mobileToken = searchParams.get('token');

  // If allowToken is true and there's a token in URL, let the page handle auth
  if (allowToken && mobileToken) {
    return <>{children}</>;
  }

  if (loading && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <svg className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (requiredRole && user?.role !== requiredRole) {
    return <Navigate to="/login" replace />;
  }

  // Owner onboarding gate: owners with incomplete onboarding are routed to the
  // wizard before accessing the rest of the app. Grandfathered users (no
  // onboardingStatus) have onboardingComplete === true and pass through.
  if (!skipOnboardingGate && requiredRole === 'owner' && user?.onboardingComplete === false) {
    return <Navigate to="/onboarding" replace />;
  }

  return <>{children}</>;
};


export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AssistantActivityProvider>
          <VoiceCommandProvider>
          <Routes>
            <Route path="/" element={<LoginSelection />} />
            <Route path="/about" element={<AboutPage />} />
            {import.meta.env.DEV && (
              <Route path="/design-system" element={<DesignSystemShowcase />} />
            )}
            <Route path="/login" element={<LoginSelection />} />
            <Route path="/login/owner" element={<OwnerLogin />} />
            <Route path="/login/tenant" element={<TenantLogin />} />
            <Route path="/signup/owner" element={<OwnerSignup />} />
            <Route path="/signup/tenant" element={<TenantSignup />} />

            <Route path="/documents/sign/:documentId" element={<DocumentSigning />} />
            <Route path="/document-scanner" element={<DocumentScanner />} />

            <Route path="/payment-receipt" element={<PaymentReceipt />} />
            <Route path="/autopay-receipt" element={<AutoPayReceipt />} />

            <Route
              path="/onboarding"
              element={
                <ProtectedRoute requiredRole="owner" skipOnboardingGate>
                  <OwnerOnboarding />
                </ProtectedRoute>
              }
            />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute requiredRole="owner">
                  <Navigate to={getDefaultOwnerHomePath()} replace />
                </ProtectedRoute>
              }
            />
            <Route
              path="/portfolio"
              element={
                <ProtectedRoute requiredRole="owner">
                  <div className="flex h-screen overflow-hidden">
                    <Sidebar />
                    <Suspense fallback={<div className="flex-1 flex items-center justify-center text-slate-400">Loading…</div>}>
                      <PortfolioPage />
                    </Suspense>
                  </div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/property-management"
              element={
                <ProtectedRoute requiredRole="owner">
                  <div className="flex h-screen overflow-hidden">
                    <Sidebar />
                    <PropertyManagementPage />
                  </div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute requiredRole="owner">
                  <div className="flex">
                    <Sidebar />
                    <ProfilePage />
                  </div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/documents"
              element={
                <ProtectedRoute requiredRole="owner">
                  <Navigate to="/property-management?tab=documents" replace />
                </ProtectedRoute>
              }
            />
            <Route
              path="/lease-builder"
              element={
                <ProtectedRoute requiredRole="owner">
                  <div className="flex">
                    <Sidebar />
                    <LeaseBuilder />
                  </div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/payment-success"
              element={
                <ProtectedRoute requiredRole="owner">
                  <div className="flex">
                    <Sidebar />
                    <PaymentSuccessPage />
                  </div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/bookkeeping"
              element={
                <ProtectedRoute requiredRole="owner">
                  <div className="flex h-screen overflow-hidden">
                    <Sidebar />
                    <BookkeepingPage />
                  </div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/sensors"
              element={
                <ProtectedRoute requiredRole="owner">
                  <div className="flex h-screen overflow-hidden">
                    <Sidebar />
                    <SensorDashboard />
                  </div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/flood-sensors"
              element={
                <ProtectedRoute requiredRole="owner">
                  <Navigate to="/sensors" replace />
                </ProtectedRoute>
              }
            />
            <Route
              path="/flood-sensors/setup"
              element={
                <ProtectedRoute requiredRole="owner">
                  <div className="flex">
                    <Sidebar />
                    <div className="flex-1 p-6">
                      <ShellySetupWizard
                        onComplete={() => { window.location.href = '/sensors'; }}
                        onCancel={() => { window.location.href = '/sensors'; }}
                      />
                    </div>
                  </div>
                </ProtectedRoute>
              }
            />
            <Route
              path="/maintenance-live"
              element={
                <ProtectedRoute requiredRole="tenant" allowToken={true}>
                  <TenantMaintenanceLivePage />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </VoiceCommandProvider>
        </AssistantActivityProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
