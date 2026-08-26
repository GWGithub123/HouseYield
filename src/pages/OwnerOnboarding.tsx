/**
 * OwnerOnboarding — resumable multi-step landlord onboarding wizard.
 *
 * Steps: Plan → Profile → Properties → Bank payout → Documents → Tenants → Review & Subscribe.
 * State is persisted to /api/onboarding/state so the wizard is resumable. The
 * monthly HouseYield subscription is collected via Stripe Checkout (Stripe Billing),
 * which is SEPARATE from the Stripe Connect payout setup embedded in the payout step.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getDefaultOwnerHomePath } from '../product/productMode';
import {
  DEFAULT_PROPERTY_USE_TYPE,
  PROPERTY_USE_TYPES,
  PROPERTY_USE_TYPE_META,
  type PropertyUseType,
} from '../types/propertyUse';
import {
  PLAN_ORDER,
  PLANS,
  formatPlanPrice,
  isSubscriptionActive,
  type PlanId,
} from '../config/plans';
import {
  onboardingClient,
  type BusinessType,
  type OnboardingState,
  type OwnerProfile,
} from '../services/onboardingClient';
import { subscriptionClient } from '../services/subscriptionClient';
import { ownerPropertiesClient } from '../services/ownerPropertiesClient';
import type { SavedProperty } from '../utils/savedProperties';
import type { PropertyDashboard } from '../types/attom';
import { uploadPropertyDocument } from '../services/storageService';
import { buildOwnerFinanceUrl, requestOwnerFinanceJson } from '../services/ownerFinanceApi';
import LandlordBankSetup from '../components/LandlordBankSetup';

type StepId = 'plan' | 'profile' | 'properties' | 'payout' | 'documents' | 'tenants' | 'review';

const STEPS: { id: StepId; title: string; subtitle: string }[] = [
  { id: 'plan', title: 'Choose a plan', subtitle: 'Remote asset protection and automation — pick how hands-off you want to be' },
  { id: 'profile', title: 'Your profile', subtitle: 'Tell us about you and your business' },
  { id: 'properties', title: 'Properties', subtitle: 'Add the properties you own' },
  { id: 'payout', title: 'Bank payout', subtitle: 'Connect a bank account to collect rent' },
  { id: 'documents', title: 'Documents', subtitle: 'Import leases and property files' },
  { id: 'tenants', title: 'Tenants', subtitle: 'Invite your existing tenants' },
  { id: 'review', title: 'Review & subscribe', subtitle: 'Confirm and start your subscription' },
];

const EMPTY_PROFILE: OwnerProfile = {
  fullName: '',
  phone: '',
  companyName: '',
  legalEntityName: '',
  businessType: 'individual',
  mailingAddress: { line1: '', line2: '', city: '', state: '', postalCode: '', country: 'US' },
};

function minimalDashboard(address: string, extra: Record<string, unknown>): PropertyDashboard {
  return ({
    summary: { address, ...extra },
    tax_history: [],
    tax_meta: {},
  } as unknown) as PropertyDashboard;
}

export default function OwnerOnboarding() {
  const navigate = useNavigate();
  const { user, updateUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Wizard data
  const [selectedPlanId, setSelectedPlanId] = useState<PlanId | null>(null);
  const [profile, setProfile] = useState<OwnerProfile>(EMPTY_PROFILE);
  const [properties, setProperties] = useState<SavedProperty[]>([]);
  const [payoutConnected, setPayoutConnected] = useState(false);
  const [payoutAccountId, setPayoutAccountId] = useState<string | null>(null);
  const [invitedTenants, setInvitedTenants] = useState<OnboardingState['invitedTenants']>([]);
  const [documentCount, setDocumentCount] = useState(0);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string>('none');
  const initializedRef = useRef(false);

  const currentStep = STEPS[stepIndex];

  const refreshProperties = useCallback(async () => {
    if (!user?.id) return;
    try {
      const list = await ownerPropertiesClient.list(user.id);
      setProperties(list);
    } catch (e) {
      console.warn('[Onboarding] Could not load properties:', e);
    }
  }, [user?.id]);

  // Initial load: hydrate state, handle Stripe Checkout return, redirect if complete.
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    (async () => {
      try {
        const state = await onboardingClient.getState();

        if (state.onboardingStatus === 'complete' && searchParams.get('subscription') !== 'success') {
          updateUser({ onboardingComplete: true });
          navigate(getDefaultOwnerHomePath(), { replace: true });
          return;
        }

        setSelectedPlanId(state.selectedPlanId);
        setProfile(state.ownerProfile ? { ...EMPTY_PROFILE, ...state.ownerProfile } : EMPTY_PROFILE);
        setPayoutConnected(state.payout?.connected ?? false);
        setPayoutAccountId(state.payout?.accountId ?? null);
        setInvitedTenants(state.invitedTenants ?? []);
        setSubscriptionStatus(state.subscriptionStatus || 'none');
        setStepIndex(Math.min(Math.max(state.onboardingStep || 0, 0), STEPS.length - 1));

        await refreshProperties();

        // Returning from Stripe Checkout?
        const subResult = searchParams.get('subscription');
        if (subResult === 'success') {
          setBanner('Confirming your subscription…');
          const status = await subscriptionClient.getStatus();
          setSubscriptionStatus(status.status);
          if (isSubscriptionActive(status.status)) {
            await onboardingClient.complete();
            updateUser({ onboardingComplete: true });
            navigate(getDefaultOwnerHomePath(), { replace: true });
            return;
          }
          setStepIndex(STEPS.length - 1);
          setBanner('Your payment is processing. This can take a moment for bank payments.');
        } else if (subResult === 'cancel') {
          setStepIndex(STEPS.length - 1);
          setBanner('Checkout canceled — you can subscribe whenever you are ready.');
        }
      } catch (e: any) {
        setError(e?.message || 'Could not load onboarding.');
      } finally {
        // Clear the subscription query param so refreshes are clean.
        if (searchParams.get('subscription')) {
          const next = new URLSearchParams(searchParams);
          next.delete('subscription');
          next.delete('session_id');
          setSearchParams(next, { replace: true });
        }
        setLoading(false);
      }
    })();
  }, [navigate, refreshProperties, searchParams, setSearchParams, updateUser]);

  const persist = useCallback(
    async (patch: Parameters<typeof onboardingClient.updateState>[0]) => {
      try {
        await onboardingClient.updateState(patch);
      } catch (e) {
        console.warn('[Onboarding] persist failed:', e);
      }
    },
    [],
  );

  const goTo = useCallback(
    async (index: number) => {
      const clamped = Math.min(Math.max(index, 0), STEPS.length - 1);
      setStepIndex(clamped);
      setError(null);
      await persist({ onboardingStep: clamped });
    },
    [persist],
  );

  const next = useCallback(() => goTo(stepIndex + 1), [goTo, stepIndex]);
  const back = useCallback(() => goTo(stepIndex - 1), [goTo, stepIndex]);

  if (!user) {
    return null;
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-blue-100">
        <div className="text-center">
          <svg className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          <p className="text-gray-600">Loading your onboarding…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-blue-100 py-8 px-4">
      <div className="max-w-5xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Welcome to HouseYield</h1>
          <p className="text-gray-600 mt-1">Protect your rentals remotely — set up takes a few minutes.</p>
        </header>

        <Stepper steps={STEPS} current={stepIndex} onSelect={(i) => goTo(i)} />

        {banner && (
          <div className="mt-6 bg-blue-50 border border-blue-200 text-blue-800 rounded-lg p-4 text-sm">
            {banner}
          </div>
        )}
        {error && (
          <div className="mt-6 bg-red-50 border border-red-200 text-red-800 rounded-lg p-4 text-sm">
            {error}
          </div>
        )}

        <div className="mt-6 bg-white rounded-2xl shadow-xl p-6 sm:p-8">
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-gray-900">{currentStep.title}</h2>
            <p className="text-gray-500">{currentStep.subtitle}</p>
          </div>

          {currentStep.id === 'plan' && (
            <PlanStep
              selectedPlanId={selectedPlanId}
              onSelect={async (planId) => {
                setSelectedPlanId(planId);
                await persist({ selectedPlanId: planId });
              }}
            />
          )}

          {currentStep.id === 'profile' && (
            <ProfileStep profile={profile} onChange={setProfile} />
          )}

          {currentStep.id === 'properties' && (
            <PropertiesStep
              ownerId={user.id}
              properties={properties}
              onAdded={refreshProperties}
              onRemoved={refreshProperties}
              setError={setError}
            />
          )}

          {currentStep.id === 'payout' && (
            <div>
              <LandlordBankSetup
                userId={user.id}
                userEmail={user.email}
                onAccountConnected={async (accountId) => {
                  setPayoutConnected(true);
                  setPayoutAccountId(accountId);
                  await persist({ payout: { connected: true, accountId } });
                }}
              />
              <p className="text-sm text-gray-500 mt-4">
                This connects your bank for collecting rent (Stripe Connect). It is separate
                from your HouseYield subscription, which you'll set up at the end.
              </p>
            </div>
          )}

          {currentStep.id === 'documents' && (
            <DocumentsStep
              ownerId={user.id}
              properties={properties}
              onUploaded={(n) => setDocumentCount((c) => c + n)}
              uploadedCount={documentCount}
              setError={setError}
            />
          )}

          {currentStep.id === 'tenants' && (
            <TenantsStep
              owner={{ id: user.id, email: user.email, name: user.name }}
              properties={properties}
              invitedTenants={invitedTenants}
              onInvited={async (record) => {
                const updated = [...invitedTenants, record];
                setInvitedTenants(updated);
                await persist({ invitedTenants: updated });
              }}
              setError={setError}
            />
          )}

          {currentStep.id === 'review' && (
            <ReviewStep
              planId={selectedPlanId}
              profile={profile}
              properties={properties}
              payoutConnected={payoutConnected}
              invitedTenants={invitedTenants}
              documentCount={documentCount}
              subscriptionStatus={subscriptionStatus}
              onSubscribe={async () => {
                if (!selectedPlanId) {
                  setError('Please choose a plan first.');
                  return;
                }
                setError(null);
                try {
                  // Persist the latest profile before leaving for Stripe.
                  await persist({ ownerProfile: profile, selectedPlanId });
                  const { url } = await subscriptionClient.createCheckoutSession(selectedPlanId);
                  window.location.href = url;
                } catch (e: any) {
                  setError(e?.message || 'Could not start checkout. Is Stripe configured?');
                }
              }}
            />
          )}

          {/* Footer nav */}
          <div className="mt-8 flex items-center justify-between border-t border-gray-100 pt-6">
            <button
              type="button"
              onClick={back}
              disabled={stepIndex === 0}
              className="px-5 py-2.5 rounded-lg text-gray-600 hover:text-gray-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Back
            </button>

            {currentStep.id !== 'review' ? (
              <button
                type="button"
                onClick={async () => {
                  // Validation per step
                  if (currentStep.id === 'plan' && !selectedPlanId) {
                    setError('Please choose a plan to continue.');
                    return;
                  }
                  if (currentStep.id === 'profile') {
                    if (!profile.fullName.trim()) {
                      setError('Please enter your full name.');
                      return;
                    }
                    await persist({ ownerProfile: profile });
                  }
                  next();
                }}
                className="px-6 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold"
              >
                Continue
              </button>
            ) : (
              <span className="text-sm text-gray-400">Finish by subscribing below</span>
            )}
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          You can skip optional steps and finish them later from your dashboard.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stepper
// ---------------------------------------------------------------------------
function Stepper({
  steps,
  current,
  onSelect,
}: {
  steps: { id: StepId; title: string }[];
  current: number;
  onSelect: (index: number) => void;
}) {
  return (
    <nav className="flex flex-wrap gap-2">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(i)}
            className={`flex items-center gap-2 px-3 py-2 rounded-full text-sm font-medium transition-colors ${
              active
                ? 'bg-blue-600 text-white'
                : done
                ? 'bg-blue-100 text-blue-700'
                : 'bg-white text-gray-500 border border-gray-200'
            }`}
          >
            <span
              className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                active ? 'bg-white text-blue-600' : done ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {done ? '✓' : i + 1}
            </span>
            {s.title}
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Plan step
// ---------------------------------------------------------------------------
function PlanStep({
  selectedPlanId,
  onSelect,
}: {
  selectedPlanId: PlanId | null;
  onSelect: (planId: PlanId) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {PLAN_ORDER.map((planId) => {
        const plan = PLANS[planId];
        const selected = selectedPlanId === planId;
        return (
          <button
            key={planId}
            type="button"
            onClick={() => onSelect(planId)}
            className={`text-left rounded-2xl border-2 p-5 transition-all ${
              selected ? 'border-blue-600 bg-blue-50 shadow-md' : 'border-gray-200 hover:border-blue-300'
            }`}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-gray-900">{plan.name}</h3>
              {plan.recommended && (
                <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded-full">Popular</span>
              )}
            </div>
            <p className="text-3xl font-extrabold text-gray-900 mt-2">{formatPlanPrice(plan)}</p>
            <p className="text-sm text-gray-500 mt-1">{plan.description}</p>
            {plan.id === 'light' && (
              <p className="text-xs text-gray-400 mt-2">Sensor kit sold separately — we ship after signup.</p>
            )}
            <ul className="mt-4 space-y-2">
              {plan.highlights.map((h) => (
                <li key={h} className="flex items-start gap-2 text-sm text-gray-700">
                  <span className="text-blue-600 mt-0.5">✓</span>
                  {h}
                </li>
              ))}
            </ul>
            <div
              className={`mt-4 text-center py-2 rounded-lg text-sm font-semibold ${
                selected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700'
              }`}
            >
              {selected ? 'Selected' : 'Select'}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile step
// ---------------------------------------------------------------------------
const INPUT = 'w-full px-4 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent';
const LABEL = 'block text-sm font-medium text-gray-700 mb-1.5';

function ProfileStep({ profile, onChange }: { profile: OwnerProfile; onChange: (p: OwnerProfile) => void }) {
  const set = (patch: Partial<OwnerProfile>) => onChange({ ...profile, ...patch });
  const setAddr = (patch: Partial<OwnerProfile['mailingAddress']>) =>
    onChange({ ...profile, mailingAddress: { ...profile.mailingAddress, ...patch } });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <label className={LABEL}>Full name *</label>
        <input className={INPUT} value={profile.fullName} onChange={(e) => set({ fullName: e.target.value })} placeholder="Jane Doe" />
      </div>
      <div>
        <label className={LABEL}>Phone</label>
        <input className={INPUT} value={profile.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="(555) 123-4567" />
      </div>
      <div>
        <label className={LABEL}>Company name</label>
        <input className={INPUT} value={profile.companyName} onChange={(e) => set({ companyName: e.target.value })} placeholder="Acme Property Co." />
      </div>
      <div>
        <label className={LABEL}>Legal entity name</label>
        <input className={INPUT} value={profile.legalEntityName} onChange={(e) => set({ legalEntityName: e.target.value })} placeholder="Acme Holdings LLC" />
      </div>
      <div>
        <label className={LABEL}>Business type</label>
        <select
          className={INPUT}
          value={profile.businessType}
          onChange={(e) => set({ businessType: e.target.value as BusinessType })}
        >
          <option value="individual">Individual</option>
          <option value="llc">LLC</option>
          <option value="corp">Corporation</option>
          <option value="trust">Trust</option>
        </select>
      </div>
      <div className="md:col-span-2 border-t border-gray-100 pt-4 mt-2">
        <h4 className="font-semibold text-gray-800 mb-3">Mailing address</h4>
      </div>
      <div className="md:col-span-2">
        <label className={LABEL}>Address line 1</label>
        <input className={INPUT} value={profile.mailingAddress.line1} onChange={(e) => setAddr({ line1: e.target.value })} placeholder="123 Main St" />
      </div>
      <div className="md:col-span-2">
        <label className={LABEL}>Address line 2</label>
        <input className={INPUT} value={profile.mailingAddress.line2} onChange={(e) => setAddr({ line2: e.target.value })} placeholder="Suite 100" />
      </div>
      <div>
        <label className={LABEL}>City</label>
        <input className={INPUT} value={profile.mailingAddress.city} onChange={(e) => setAddr({ city: e.target.value })} />
      </div>
      <div>
        <label className={LABEL}>State</label>
        <input className={INPUT} value={profile.mailingAddress.state} onChange={(e) => setAddr({ state: e.target.value })} />
      </div>
      <div>
        <label className={LABEL}>Postal code</label>
        <input className={INPUT} value={profile.mailingAddress.postalCode} onChange={(e) => setAddr({ postalCode: e.target.value })} />
      </div>
      <div>
        <label className={LABEL}>Country</label>
        <input className={INPUT} value={profile.mailingAddress.country} onChange={(e) => setAddr({ country: e.target.value })} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Properties step
// ---------------------------------------------------------------------------
function PropertiesStep({
  ownerId,
  properties,
  onAdded,
  onRemoved,
  setError,
}: {
  ownerId: string;
  properties: SavedProperty[];
  onAdded: () => Promise<void>;
  onRemoved: () => Promise<void>;
  setError: (msg: string | null) => void;
}) {
  const [address, setAddress] = useState('');
  const [propertyType, setPropertyType] = useState('single_family');
  const [useType, setUseType] = useState<PropertyUseType>(DEFAULT_PROPERTY_USE_TYPE);
  const [unitCount, setUnitCount] = useState('1');
  const [ownershipEntity, setOwnershipEntity] = useState('');
  const [saving, setSaving] = useState(false);

  const addProperty = async () => {
    if (!address.trim()) {
      setError('Enter a property address.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await ownerPropertiesClient.save({
        ownerId,
        address: address.trim(),
        propertyData: minimalDashboard(address.trim(), {
          propertyType,
          useType,
          unitCount: Number(unitCount) || 1,
          ownershipEntity: ownershipEntity.trim() || null,
        }),
        financials: {},
      });
      setAddress('');
      setUseType(DEFAULT_PROPERTY_USE_TYPE);
      setUnitCount('1');
      setOwnershipEntity('');
      await onAdded();
    } catch (e: any) {
      setError(e?.message || 'Could not save property.');
    } finally {
      setSaving(false);
    }
  };

  const removeProperty = async (id: string) => {
    try {
      await ownerPropertiesClient.remove(ownerId, id);
      await onRemoved();
    } catch (e: any) {
      setError(e?.message || 'Could not remove property.');
    }
  };

  return (
    <div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 rounded-xl p-4">
        <div className="md:col-span-2">
          <label className={LABEL}>Property address *</label>
          <input className={INPUT} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Oak Ave, Springfield, IL" />
        </div>
        <div>
          <label className={LABEL}>Type</label>
          <select className={INPUT} value={propertyType} onChange={(e) => setPropertyType(e.target.value)}>
            <option value="single_family">Single family</option>
            <option value="multi_family">Multi-family</option>
            <option value="condo">Condo</option>
            <option value="townhouse">Townhouse</option>
            <option value="commercial">Commercial</option>
          </select>
        </div>
        <div>
          <label className={LABEL}>Units</label>
          <input className={INPUT} type="number" min={1} value={unitCount} onChange={(e) => setUnitCount(e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className={LABEL}>How is it used?</label>
          <select
            className={INPUT}
            value={useType}
            onChange={(e) => setUseType(e.target.value as PropertyUseType)}
          >
            {PROPERTY_USE_TYPES.map((id) => (
              <option key={id} value={id}>
                {PROPERTY_USE_TYPE_META[id].label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">
            {PROPERTY_USE_TYPE_META[useType].description}
            {PROPERTY_USE_TYPE_META[useType].rental
              ? ' — rental analytics will be shown for this property.'
              : ' — we will show value and tax history instead of rental analytics.'}
          </p>
        </div>
        <div className="md:col-span-2">
          <label className={LABEL}>Ownership entity (optional)</label>
          <input className={INPUT} value={ownershipEntity} onChange={(e) => setOwnershipEntity(e.target.value)} placeholder="Acme Holdings LLC" />
        </div>
        <div className="md:col-span-2">
          <button
            type="button"
            onClick={addProperty}
            disabled={saving}
            className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:bg-gray-400"
          >
            {saving ? 'Adding…' : '+ Add property'}
          </button>
        </div>
      </div>

      <div className="mt-6">
        <h4 className="font-semibold text-gray-800 mb-3">Your properties ({properties.length})</h4>
        {properties.length === 0 ? (
          <p className="text-sm text-gray-500">No properties yet. Add your first one above.</p>
        ) : (
          <ul className="space-y-2">
            {properties.map((p) => (
              <li key={p.id} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3">
                <span className="text-gray-800">{p.address}</span>
                <button type="button" onClick={() => removeProperty(p.id)} className="text-sm text-red-600 hover:text-red-700">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents step
// ---------------------------------------------------------------------------
function DocumentsStep({
  ownerId,
  properties,
  onUploaded,
  uploadedCount,
  setError,
}: {
  ownerId: string;
  properties: SavedProperty[];
  onUploaded: (n: number) => void;
  uploadedCount: number;
  setError: (msg: string | null) => void;
}) {
  const [propertyId, setPropertyId] = useState<string>(properties[0]?.id || '');
  const [category, setCategory] = useState('lease');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!propertyId && properties[0]) setPropertyId(properties[0].id);
  }, [properties, propertyId]);

  // Enable folder selection where the browser supports it.
  useEffect(() => {
    if (folderInputRef.current) {
      folderInputRef.current.setAttribute('webkitdirectory', '');
      folderInputRef.current.setAttribute('directory', '');
    }
  }, []);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!propertyId) {
      setError('Add a property first, then attach documents to it.');
      return;
    }
    setBusy(true);
    setError(null);
    let success = 0;
    const fileArray = Array.from(files);
    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      setProgress(`Uploading ${i + 1} of ${fileArray.length}: ${file.name}`);
      try {
        const result = await uploadPropertyDocument(ownerId, propertyId, file);
        if (result.success) {
          await requestOwnerFinanceJson(
            buildOwnerFinanceUrl('/api/documents/save-metadata'),
            {
              method: 'POST',
              body: JSON.stringify({
                ownerId,
                propertyId,
                title: file.name,
                fileName: file.name,
                fileType: file.type,
                fileExtension: file.name.split('.').pop() || '',
                fileSize: file.size,
                fileUrl: result.downloadURL,
                storagePath: result.storagePath,
                category,
              }),
            },
            { 'Content-Type': 'application/json' },
          ).catch((e) => console.warn('[Onboarding] save-metadata failed:', e));
          success += 1;
        }
      } catch (e) {
        console.warn('[Onboarding] document upload failed:', e);
      }
    }
    setProgress('');
    setBusy(false);
    onUploaded(success);
  };

  return (
    <div>
      {properties.length === 0 ? (
        <p className="text-sm text-gray-500">Add a property in the previous step before importing documents.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>Property</label>
              <select className={INPUT} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.address}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>Category</label>
              <select className={INPUT} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="lease">Lease</option>
                <option value="insurance">Insurance</option>
                <option value="tax">Tax</option>
                <option value="inspection">Inspection</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-xl p-6 cursor-pointer hover:border-blue-400">
              <span className="text-sm font-medium text-gray-700">Select files</span>
              <span className="text-xs text-gray-400 mt-1">Leases, PDFs, images</span>
              <input type="file" multiple className="hidden" disabled={busy} onChange={(e) => handleFiles(e.target.files)} />
            </label>
            <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-300 rounded-xl p-6 cursor-pointer hover:border-blue-400">
              <span className="text-sm font-medium text-gray-700">Select a folder</span>
              <span className="text-xs text-gray-400 mt-1">Uploads all files in the folder</span>
              <input ref={folderInputRef} type="file" multiple className="hidden" disabled={busy} onChange={(e) => handleFiles(e.target.files)} />
            </label>
          </div>

          {busy && <p className="text-sm text-blue-600 mt-3">{progress}</p>}
          {uploadedCount > 0 && !busy && (
            <p className="text-sm text-green-600 mt-3">{uploadedCount} document(s) imported.</p>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tenants step
// ---------------------------------------------------------------------------
function TenantsStep({
  owner,
  properties,
  invitedTenants,
  onInvited,
  setError,
}: {
  owner: { id: string; email: string; name: string };
  properties: SavedProperty[];
  invitedTenants: OnboardingState['invitedTenants'];
  onInvited: (record: OnboardingState['invitedTenants'][number]) => Promise<void>;
  setError: (msg: string | null) => void;
}) {
  const [propertyId, setPropertyId] = useState<string>(properties[0]?.id || '');
  const [unit, setUnit] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [tenantEmail, setTenantEmail] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!propertyId && properties[0]) setPropertyId(properties[0].id);
  }, [properties, propertyId]);

  const selectedProperty = properties.find((p) => p.id === propertyId);

  const invite = async () => {
    if (!propertyId || !selectedProperty) {
      setError('Add a property first.');
      return;
    }
    if (!tenantEmail.trim()) {
      setError('Enter the tenant email.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const payload = await requestOwnerFinanceJson(
        buildOwnerFinanceUrl('/api/tenants/invite'),
        {
          method: 'POST',
          body: JSON.stringify({
            ownerId: owner.id,
            ownerEmail: owner.email,
            ownerName: owner.name,
            propertyId,
            propertyAddress: selectedProperty.address,
            unit: unit.trim(),
            tenantEmail: tenantEmail.trim(),
            tenantName: tenantName.trim() || 'Tenant',
          }),
        },
        { 'Content-Type': 'application/json' },
      );
      if (payload && payload.ok === false) {
        throw new Error(payload.error || 'Invite failed');
      }
      await onInvited({
        email: tenantEmail.trim(),
        name: tenantName.trim() || 'Tenant',
        propertyId,
        status: payload?.emailSent ? 'invited' : 'pending',
        invitedAt: new Date().toISOString(),
      });
      setTenantName('');
      setTenantEmail('');
      setUnit('');
    } catch (e: any) {
      setError(e?.message || 'Could not send invite.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      {properties.length === 0 ? (
        <p className="text-sm text-gray-500">Add a property before inviting tenants.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-gray-50 rounded-xl p-4">
            <div>
              <label className={LABEL}>Property</label>
              <select className={INPUT} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>{p.address}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL}>Unit (optional)</label>
              <input className={INPUT} value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="1A" />
            </div>
            <div>
              <label className={LABEL}>Tenant name</label>
              <input className={INPUT} value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="John Smith" />
            </div>
            <div>
              <label className={LABEL}>Tenant email *</label>
              <input className={INPUT} type="email" value={tenantEmail} onChange={(e) => setTenantEmail(e.target.value)} placeholder="tenant@example.com" />
            </div>
            <div className="md:col-span-2">
              <button
                type="button"
                onClick={invite}
                disabled={sending}
                className="px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:bg-gray-400"
              >
                {sending ? 'Sending…' : 'Send invite'}
              </button>
            </div>
          </div>

          <div className="mt-6">
            <h4 className="font-semibold text-gray-800 mb-3">Invited tenants ({invitedTenants.length})</h4>
            {invitedTenants.length === 0 ? (
              <p className="text-sm text-gray-500">No invites sent yet.</p>
            ) : (
              <ul className="space-y-2">
                {invitedTenants.map((t, i) => (
                  <li key={`${t.email}-${i}`} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-3">
                    <span className="text-gray-800">{t.name} — {t.email}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{t.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review & subscribe step
// ---------------------------------------------------------------------------
function ReviewStep({
  planId,
  profile,
  properties,
  payoutConnected,
  invitedTenants,
  documentCount,
  subscriptionStatus,
  onSubscribe,
}: {
  planId: PlanId | null;
  profile: OwnerProfile;
  properties: SavedProperty[];
  payoutConnected: boolean;
  invitedTenants: OnboardingState['invitedTenants'];
  documentCount: number;
  subscriptionStatus: string;
  onSubscribe: () => Promise<void>;
}) {
  const plan = planId ? PLANS[planId] : null;
  const [submitting, setSubmitting] = useState(false);
  const active = isSubscriptionActive(subscriptionStatus);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SummaryCard title="Plan" value={plan ? `${plan.name} — ${formatPlanPrice(plan)}` : 'Not selected'} />
        <SummaryCard title="Owner" value={profile.fullName || '—'} sub={profile.companyName} />
        <SummaryCard title="Properties" value={`${properties.length}`} />
        <SummaryCard title="Tenants invited" value={`${invitedTenants.length}`} />
        <SummaryCard title="Documents imported" value={`${documentCount}`} />
        <SummaryCard title="Bank payout" value={payoutConnected ? 'Connected' : 'Not connected'} />
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600">Monthly subscription</p>
          <p className="text-2xl font-bold text-gray-900">{plan ? formatPlanPrice(plan) : '—'}</p>
        </div>
        {active ? (
          <span className="px-4 py-2 rounded-lg bg-green-600 text-white font-semibold">Subscription active</span>
        ) : (
          <button
            type="button"
            disabled={!plan || submitting}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onSubscribe();
              } finally {
                setSubmitting(false);
              }
            }}
            className="px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:bg-gray-400"
          >
            {submitting ? 'Redirecting…' : 'Subscribe & finish'}
          </button>
        )}
      </div>
      <p className="text-xs text-gray-400">
        You'll be redirected to Stripe's secure checkout to enter your card or bank details for the
        monthly HouseYield subscription. This is separate from your rent-collection bank setup.
      </p>
    </div>
  );
}

function SummaryCard({ title, value, sub }: { title: string; value: string; sub?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs uppercase tracking-wide text-gray-400">{title}</p>
      <p className="text-lg font-semibold text-gray-900 mt-1">{value}</p>
      {sub ? <p className="text-sm text-gray-500">{sub}</p> : null}
    </div>
  );
}
