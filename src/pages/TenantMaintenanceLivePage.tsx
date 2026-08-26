import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import MaintenanceRequestForm from '../components/MaintenanceRequestForm';
import { useAuth } from '../contexts/AuthContext';

interface TokenUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface TenantDetails {
  propertyAddress?: string;
  unit?: string;
  ownerId?: string;
  landlordId?: string;
  propertyId?: string;
}

export default function TenantMaintenanceLivePage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const mobileToken = searchParams.get('token');
  const fallbackIssue = searchParams.get('issue') || '';
  const fallbackLocation = searchParams.get('location') || '';
  const fallbackAddress = searchParams.get('propertyAddress') || '';
  const fallbackUnit = searchParams.get('unit') || '';

  const [tokenValidating, setTokenValidating] = useState(Boolean(mobileToken));
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenUser, setTokenUser] = useState<TokenUser | null>(null);
  const [tenantDetails, setTenantDetails] = useState<TenantDetails | null>(null);

  const effectiveUser = tokenUser || (user?.role === 'tenant' ? {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role
  } : null);

  useEffect(() => {
    const validateToken = async () => {
      if (!mobileToken) {
        setTokenValidating(false);
        return;
      }

      try {
        const response = await fetch('/api/auth/validate-mobile-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: mobileToken })
        });

        const data = await response.json();
        if (!response.ok || !data.ok || !data.user) {
          throw new Error(data.error || 'Invalid or expired token');
        }

        if (data.user.role !== 'tenant') {
          throw new Error('This secure link is only valid for tenant maintenance assistance.');
        }

        setTokenUser(data.user);
        setTokenError(null);
        // Store token in sessionStorage so LiveMaintenanceAssistant can
        // attach it to API requests when accessed through the tunnel
        if (mobileToken) {
          sessionStorage.setItem('mobileScanToken', mobileToken);
        }
      } catch (error: any) {
        setTokenError(error.message || 'Failed to validate secure phone link');
      } finally {
        setTokenValidating(false);
      }
    };

    void validateToken();
  }, [mobileToken]);

  useEffect(() => {
    const loadTenantDetails = async () => {
      if (!effectiveUser?.id) return;

      try {
        const response = await fetch(`/api/tenants/${effectiveUser.id}`);
        const data = await response.json();
        if (data.ok && data.tenant) {
          setTenantDetails(data.tenant);
        }
      } catch (error) {
        console.error('[TenantMaintenanceLivePage] Failed to load tenant details:', error);
      }
    };

    void loadTenantDetails();
  }, [effectiveUser?.id]);

  if (tokenValidating) {
    return (
      <div className="min-h-screen bg-slate-950 px-6 py-12 text-white">
        <div className="mx-auto max-w-md rounded-3xl bg-white p-8 text-center text-slate-900 shadow-2xl">
          <div className="mx-auto mb-6 h-16 w-16 animate-spin rounded-full border-4 border-emerald-200 border-t-emerald-600" />
          <h1 className="text-xl font-bold">Validating secure link</h1>
          <p className="mt-2 text-sm text-slate-600">Connecting your phone to the maintenance assistant.</p>
        </div>
      </div>
    );
  }

  if (tokenError) {
    return (
      <div className="min-h-screen bg-slate-950 px-6 py-12 text-white">
        <div className="mx-auto max-w-md rounded-3xl bg-white p-8 text-center text-slate-900 shadow-2xl">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold">Secure link unavailable</h1>
          <p className="mt-2 text-sm text-slate-600">{tokenError}</p>
          <p className="mt-4 text-xs text-slate-500">Scan a fresh QR code from the tenant portal to open a new live maintenance session.</p>
        </div>
      </div>
    );
  }

  if (!effectiveUser) {
    return (
      <div className="min-h-screen bg-slate-950 px-6 py-12 text-white">
        <div className="mx-auto max-w-md rounded-3xl bg-white p-8 text-center text-slate-900 shadow-2xl">
          <h1 className="text-xl font-bold">Tenant sign-in required</h1>
          <p className="mt-2 text-sm text-slate-600">Open this page from the secure QR code in the tenant portal, or sign in as the tenant first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.18),_transparent_38%),linear-gradient(180deg,_#ecfdf5_0%,_#f8fafc_45%,_#ffffff_100%)] px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="rounded-3xl border border-emerald-200 bg-white/90 p-6 shadow-sm backdrop-blur">
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700">Tenant mobile session</div>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">Live AI Maintenance Assistant</h1>
          <p className="mt-2 text-sm text-slate-600">
            Start the live voice session below, point your phone camera at the issue, then let the assistant build the maintenance request draft for you.
          </p>
          {(fallbackAddress || tenantDetails?.propertyAddress) && (
            <div className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-slate-700">
              Property: {[tenantDetails?.propertyAddress || fallbackAddress, tenantDetails?.unit || fallbackUnit].filter(Boolean).join(' ')}
            </div>
          )}
          {(fallbackIssue || fallbackLocation) && (
            <div className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
              Current issue context: {[fallbackIssue, fallbackLocation].filter(Boolean).join(' | ')}
            </div>
          )}
        </div>

        <MaintenanceRequestForm
          propertyAddress={tenantDetails?.propertyAddress || fallbackAddress}
          unit={tenantDetails?.unit || fallbackUnit}
          tenantId={effectiveUser.id}
          tenantEmail={effectiveUser.email}
          tenantName={effectiveUser.name}
          ownerId={tenantDetails?.ownerId || tenantDetails?.landlordId}
          propertyId={tenantDetails?.propertyId}
          showLiveAssistantInline={true}
        />
      </div>
    </div>
  );
}
