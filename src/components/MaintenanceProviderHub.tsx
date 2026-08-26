import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { extractStateCode } from '../services/regionalDataService';
import { getTrustedProviders, saveTrustedProviders, type TrustedProvider } from './TrustedProviders';
import { Badge, Button, CardHeader } from '../design-system';
import { getDevApiBaseUrl } from '../utils/devApiBase';

type DiscoverySource = 'places_legacy' | 'places_new' | 'custom_search' | 'regional_seed' | string;

type CategoryOption = {
  label: string;
  searchKey: string;
  icon: string;
};

type DiscoveredProvider = {
  placeId?: string | null;
  name: string;
  phone?: string | null;
  website?: string | null;
  address?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  combinedScore?: number | null;
  qualityScore?: number | null;
  popularityScore?: number | null;
  contactCompletenessScore?: number | null;
  searchSource?: DiscoverySource | null;
  googleMapsUrl?: string | null;
  openNow?: boolean;
  weekdayHours?: string[];
  snippet?: string | null;
  businessStatus?: string | null;
};

type DiscoveryResponse = {
  ok: boolean;
  error?: string;
  providers?: DiscoveredProvider[];
  location?: {
    formattedAddress?: string;
  };
  searchSource?: DiscoverySource;
};

const CATEGORY_OPTIONS: CategoryOption[] = [
  { label: 'General Repair', searchKey: 'general', icon: '🛠️' },
  { label: 'Plumbing', searchKey: 'plumbing', icon: '🔧' },
  { label: 'Electrical', searchKey: 'electrical', icon: '⚡' },
  { label: 'HVAC', searchKey: 'hvac', icon: '❄️' },
  { label: 'Appliances', searchKey: 'appliance', icon: '🔌' },
  { label: 'Structural', searchKey: 'general', icon: '🏗️' },
  { label: 'Pest Control', searchKey: 'pest_control', icon: '🐜' },
  { label: 'Lock/Security', searchKey: 'locksmith', icon: '🔒' },
  { label: 'Roofing', searchKey: 'roofing', icon: '🏠' },
  { label: 'Landscaping', searchKey: 'landscaping', icon: '🌳' },
  { label: 'Other', searchKey: 'general', icon: '📋' },
];

const DEFAULT_CATEGORY = 'General Repair';

function normalizeText(value: string | null | undefined) {
  return String(value || '').trim().toLowerCase();
}

function buildProviderMatchKey(provider: { name?: string | null; phone?: string | null; website?: string | null }, category: string) {
  return [
    normalizeText(provider.name),
    normalizeText(provider.phone).replace(/\D/g, ''),
    normalizeText(provider.website),
    normalizeText(category),
  ].join('::');
}

function getSourceLabel(source?: DiscoverySource | null) {
  switch (source) {
    case 'places_legacy':
    case 'places_new':
      return 'Google Places';
    case 'custom_search':
      return 'Google web search';
    case 'regional_seed':
      return 'Curated regional fallback';
    default:
      return 'Local provider search';
  }
}

function getSourceTone(source?: DiscoverySource | null) {
  switch (source) {
    case 'places_legacy':
    case 'places_new':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'custom_search':
      return 'bg-blue-50 text-blue-700 border-blue-200';
    case 'regional_seed':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    default:
      return 'bg-slate-50 text-slate-700 border-slate-200';
  }
}

function formatRating(rating?: number | null) {
  if (typeof rating !== 'number' || Number.isNaN(rating)) {
    return 'No rating yet';
  }
  return rating.toFixed(1);
}

function formatAddedAt(value?: string) {
  if (!value) return 'Recently added';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently added';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function categoryOptionFor(label: string) {
  return CATEGORY_OPTIONS.find((entry) => entry.label === label) || CATEGORY_OPTIONS[0];
}

interface MaintenanceProviderHubProps {
  propertyScopeId?: string;
  propertyAddress?: string;
  region?: string;
}

export default function MaintenanceProviderHub({
  propertyScopeId,
  propertyAddress,
  region: regionProp,
}: MaintenanceProviderHubProps) {
  const { user } = useAuth();
  const [trustedProviders, setTrustedProviders] = useState<TrustedProvider[]>([]);
  const [discoveredProviders, setDiscoveredProviders] = useState<DiscoveredProvider[]>([]);
  const [selectedCategory, setSelectedCategory] = useState(DEFAULT_CATEGORY);
  const [loadingDiscoveries, setLoadingDiscoveries] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [searchSource, setSearchSource] = useState<DiscoverySource | null>(null);
  const [searchLocation, setSearchLocation] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formWebsite, setFormWebsite] = useState('');
  const [formCategories, setFormCategories] = useState<string[]>([]);
  const [formNotes, setFormNotes] = useState('');
  const [savingTrusted, setSavingTrusted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const resolvedRegion = regionProp || (propertyAddress ? extractStateCode(propertyAddress) : '');
  const baseUrl = getDevApiBaseUrl();
  const selectedCategoryOption = categoryOptionFor(selectedCategory);

  const loadTrustedProviders = useCallback(async () => {
    if (!user?.id) {
      setTrustedProviders([]);
      return;
    }

    const allProviders = await getTrustedProviders(user.id);
    const scopedProviders = propertyScopeId
      ? allProviders.filter((provider) => provider.propertyScopeId === propertyScopeId)
      : allProviders;
    setTrustedProviders(scopedProviders);
  }, [propertyScopeId, user?.id]);

  useEffect(() => {
    void loadTrustedProviders();

    const handleUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<TrustedProvider[]>;
      const nextProviders = propertyScopeId
        ? customEvent.detail.filter((provider) => provider.propertyScopeId === propertyScopeId)
        : customEvent.detail;
      setTrustedProviders(nextProviders);
    };

    window.addEventListener('trustedProvidersUpdated', handleUpdate);
    return () => window.removeEventListener('trustedProvidersUpdated', handleUpdate);
  }, [loadTrustedProviders, propertyScopeId]);

  const approvedProviderKeys = useMemo(() => {
    return new Set(
      trustedProviders.flatMap((provider) =>
        provider.categories.map((category) => buildProviderMatchKey(provider, category))
      )
    );
  }, [trustedProviders]);

  const visibleTrustedProviders = useMemo(() => {
    return trustedProviders
      .filter((provider) => provider.categories.includes(selectedCategory))
      .sort((left, right) => {
        const leftTime = new Date(left.addedAt).getTime();
        const rightTime = new Date(right.addedAt).getTime();
        return rightTime - leftTime;
      });
  }, [selectedCategory, trustedProviders]);

  const visibleDiscoveredProviders = useMemo(() => {
    return discoveredProviders.filter((provider) => !approvedProviderKeys.has(buildProviderMatchKey(provider, selectedCategory)));
  }, [approvedProviderKeys, discoveredProviders, selectedCategory]);

  const resetForm = useCallback(() => {
    setFormName('');
    setFormPhone('');
    setFormEmail('');
    setFormWebsite('');
    setFormCategories([selectedCategory]);
    setFormNotes('');
    setEditingId(null);
    setFormOpen(false);
    setSaveError(null);
  }, [selectedCategory]);

  const startAddingProvider = useCallback(() => {
    setEditingId(null);
    setFormName('');
    setFormPhone('');
    setFormEmail('');
    setFormWebsite('');
    setFormCategories([selectedCategory]);
    setFormNotes('');
    setSaveError(null);
    setFormOpen(true);
  }, [selectedCategory]);

  const startEditingProvider = useCallback((provider: TrustedProvider) => {
    setEditingId(provider.id);
    setFormName(provider.name);
    setFormPhone(provider.phone);
    setFormEmail(provider.email || '');
    setFormWebsite(provider.website || '');
    setFormCategories(provider.categories);
    setFormNotes(provider.notes || '');
    setSaveError(null);
    setFormOpen(true);
  }, []);

  const fetchDiscoveries = useCallback(async () => {
    if (!propertyAddress) {
      setDiscoveredProviders([]);
      setSearchLocation(null);
      setSearchSource(null);
      setDiscoveryError(null);
      return;
    }

    setLoadingDiscoveries(true);
    setDiscoveryError(null);

    try {
      const params = new URLSearchParams({
        quick: 'true',
        serviceCategory: selectedCategoryOption.searchKey,
        location: propertyAddress,
        limit: '6',
      });

      const response = await fetch(`${baseUrl}/api/smart-provider-search?${params.toString()}`);
      const data = (await response.json()) as DiscoveryResponse;

      if (!response.ok || !data.ok) {
        throw new Error(data.error || 'Failed to search local providers');
      }

      setDiscoveredProviders(Array.isArray(data.providers) ? data.providers : []);
      setSearchLocation(data.location?.formattedAddress || propertyAddress);
      setSearchSource(data.searchSource || null);
    } catch (error: any) {
      setDiscoveredProviders([]);
      setSearchLocation(propertyAddress);
      setSearchSource(null);
      setDiscoveryError(error.message || 'Failed to search local providers');
    } finally {
      setLoadingDiscoveries(false);
    }
  }, [baseUrl, propertyAddress, selectedCategoryOption.searchKey]);

  useEffect(() => {
    void fetchDiscoveries();
  }, [fetchDiscoveries]);

  const toggleFormCategory = (category: string) => {
    setFormCategories((current) => (
      current.includes(category)
        ? current.filter((entry) => entry !== category)
        : [...current, category]
    ));
  };

  const persistTrustedProviders = async (providers: TrustedProvider[]) => {
    if (!user?.id) {
      setSaveError('Sign in to manage trusted providers.');
      return false;
    }

    setSavingTrusted(true);
    setSaveError(null);

    const result = await saveTrustedProviders(user.id, providers);
    setSavingTrusted(false);

    if (!result.success) {
      setSaveError(result.error || 'Failed to save trusted providers');
      return false;
    }

    setActionMessage('Trusted providers updated.');
    return true;
  };

  const handleSaveTrustedProvider = async () => {
    if (!user?.id) {
      setSaveError('Sign in to manage trusted providers.');
      return;
    }

    if (!formName.trim() || !formPhone.trim() || formCategories.length === 0) {
      setSaveError('Name, phone, and at least one category are required.');
      return;
    }

    const allProviders = await getTrustedProviders(user.id);
    const nextProvider: TrustedProvider = {
      id: editingId || `tp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name: formName.trim(),
      phone: formPhone.trim(),
      email: formEmail.trim() || undefined,
      website: formWebsite.trim() || undefined,
      categories: formCategories,
      notes: formNotes.trim() || undefined,
      addedAt: editingId
        ? allProviders.find((provider) => provider.id === editingId)?.addedAt || new Date().toISOString()
        : new Date().toISOString(),
      propertyScopeId: propertyScopeId || undefined,
      propertyAddress: propertyAddress || undefined,
      region: resolvedRegion || undefined,
    };

    const updatedProviders = editingId
      ? allProviders.map((provider) => (provider.id === editingId ? nextProvider : provider))
      : [...allProviders, nextProvider];

    const saved = await persistTrustedProviders(updatedProviders);
    if (saved) {
      resetForm();
    }
  };

  const handleDeleteTrustedProvider = async (providerId: string) => {
    if (!user?.id) {
      setSaveError('Sign in to manage trusted providers.');
      return;
    }

    const allProviders = await getTrustedProviders(user.id);
    const updatedProviders = allProviders.filter((provider) => provider.id !== providerId);
    await persistTrustedProviders(updatedProviders);
  };

  const handleApproveProvider = async (provider: DiscoveredProvider) => {
    if (!user?.id) {
      setDiscoveryError('Sign in to approve providers into your trusted list.');
      return;
    }

    if (!provider.phone) {
      setDiscoveryError('This provider is missing a phone number, so it cannot be approved for dispatch yet.');
      return;
    }

    const allProviders = await getTrustedProviders(user.id);
    const normalizedPhone = normalizeText(provider.phone).replace(/\D/g, '');
    const normalizedName = normalizeText(provider.name);

    const existingProvider = allProviders.find((entry) => {
      const sameScope = propertyScopeId ? entry.propertyScopeId === propertyScopeId : true;
      const phoneMatches = normalizedPhone && normalizeText(entry.phone).replace(/\D/g, '') === normalizedPhone;
      const nameMatches = normalizedName && normalizeText(entry.name) === normalizedName;
      return sameScope && (phoneMatches || nameMatches);
    });

    const discoveryNote = `Approved from ${getSourceLabel(provider.searchSource)} discovery for ${selectedCategory}.`;

    const updatedProviders = existingProvider
      ? allProviders.map((entry) => {
          if (entry.id !== existingProvider.id) return entry;
          return {
            ...entry,
            phone: entry.phone || provider.phone || '',
            website: entry.website || provider.website || undefined,
            categories: Array.from(new Set([...entry.categories, selectedCategory])),
            notes: entry.notes || discoveryNote,
            propertyScopeId: entry.propertyScopeId || propertyScopeId || undefined,
            propertyAddress: entry.propertyAddress || propertyAddress || undefined,
            region: entry.region || resolvedRegion || undefined,
          };
        })
      : [
          ...allProviders,
          {
            id: `tp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            name: provider.name,
            phone: provider.phone,
            email: undefined,
            website: provider.website || undefined,
            categories: [selectedCategory],
            notes: discoveryNote,
            addedAt: new Date().toISOString(),
            propertyScopeId: propertyScopeId || undefined,
            propertyAddress: propertyAddress || undefined,
            region: resolvedRegion || undefined,
          },
        ];

    const saved = await persistTrustedProviders(updatedProviders);
    if (saved) {
      setActionMessage(`${provider.name} is now trusted for ${selectedCategory}.`);
    }
  };

  return (
    <div>
      <CardHeader
        title="Providers"
        subtitle={
          propertyAddress
            ? <>Trusted list and live local discoveries for <span className="font-medium text-slate-700">{propertyAddress}</span>.</>
            : 'Trusted list and live local discoveries for the selected property.'
        }
        right={
          <>
            <Button variant="secondary" size="sm" onClick={startAddingProvider}>Add trusted</Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void fetchDiscoveries()}
              disabled={loadingDiscoveries || !propertyAddress}
              loading={loadingDiscoveries}
            >
              {loadingDiscoveries ? 'Refreshing' : 'Refresh search'}
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 px-5 py-3">
        {CATEGORY_OPTIONS.map((option) => {
          const isActive = selectedCategory === option.label;
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => setSelectedCategory(option.label)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                isActive
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
              }`}
            >
              {option.icon} {option.label}
            </button>
          );
        })}
      </div>

      {formOpen && (
        <div className="border-b border-slate-100 bg-slate-50 p-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-900">{editingId ? 'Edit trusted provider' : 'Add trusted provider'}</div>
              <p className="mt-1 text-xs text-slate-500">
                Trusted providers are auto-selected for matching maintenance requests at this property.
              </p>
            </div>
            <button
              type="button"
              onClick={resetForm}
              className="self-start rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <input
              type="text"
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              placeholder="Company name"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
            <input
              type="tel"
              value={formPhone}
              onChange={(event) => setFormPhone(event.target.value)}
              placeholder="Phone"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
            <input
              type="email"
              value={formEmail}
              onChange={(event) => setFormEmail(event.target.value)}
              placeholder="Email"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
            <input
              type="url"
              value={formWebsite}
              onChange={(event) => setFormWebsite(event.target.value)}
              placeholder="Website"
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
          </div>

          <div className="mt-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Categories</div>
            <div className="flex flex-wrap gap-2">
              {CATEGORY_OPTIONS.map((option) => {
                const isSelected = formCategories.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => toggleFormCategory(option.label)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      isSelected
                        ? 'bg-sky-100 text-sky-700 ring-1 ring-inset ring-sky-300'
                        : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    {option.icon} {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <textarea
            value={formNotes}
            onChange={(event) => setFormNotes(event.target.value)}
            rows={2}
            placeholder="Notes, preferred scheduling, emergency coverage, dispatch guidance..."
            className="mt-4 w-full rounded-2xl border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-200"
          />

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleSaveTrustedProvider()}
              disabled={savingTrusted}
              className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {savingTrusted ? 'Saving...' : editingId ? 'Save changes' : 'Add provider'}
            </button>
            {saveError && <div className="text-sm text-red-600">{saveError}</div>}
          </div>
        </div>
      )}

      {actionMessage && (
        <div className="border-b border-slate-100 bg-emerald-50 px-5 py-2.5 text-sm text-emerald-700">
          {actionMessage}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-3 px-5 pt-4">
          <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">
            Trusted for {selectedCategory}
          </div>
          <Badge tone="neutral">{visibleTrustedProviders.length}</Badge>
        </div>

        {visibleTrustedProviders.length === 0 ? (
          <div className="px-5 py-5 text-sm text-slate-500">
            No trusted providers saved for {selectedCategory} yet. Approve a discovered business below or add one manually.
          </div>
        ) : (
          <div className="grid gap-3 p-5 pt-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleTrustedProviders.map((provider) => (
              <div key={provider.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">{provider.name}</div>
                    <div className="mt-1 text-xs text-slate-500">Trusted for auto-dispatch</div>
                  </div>
                  <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-700">
                    Trusted
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap gap-1">
                  {provider.categories.map((category) => (
                    <span key={category} className="rounded-full bg-white px-2 py-1 text-[11px] font-medium text-slate-600 ring-1 ring-inset ring-slate-200">
                      {categoryOptionFor(category).icon} {category}
                    </span>
                  ))}
                </div>

                <div className="mt-3 space-y-1 text-xs text-slate-600">
                  <a href={`tel:${provider.phone}`} className="block font-medium text-blue-600 hover:text-blue-700">
                    {provider.phone}
                  </a>
                  {provider.website && (
                    <a href={provider.website} target="_blank" rel="noreferrer" className="block truncate text-blue-600 hover:text-blue-700">
                      {provider.website}
                    </a>
                  )}
                  {provider.email && <div className="truncate">{provider.email}</div>}
                  {provider.notes && <div className="line-clamp-2 text-slate-500">{provider.notes}</div>}
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <div className="text-[11px] text-slate-400">Added {formatAddedAt(provider.addedAt)}</div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => startEditingProvider(provider)}
                      className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteTrustedProvider(provider.id)}
                      className="rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-slate-100">
        <div className="flex flex-col gap-2 px-5 pt-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400">Nearby discoveries</div>
            <div className="mt-0.5 text-xs text-slate-500">
              Real {selectedCategory.toLowerCase()} businesses near {searchLocation || propertyAddress || 'the selected property'}.
            </div>
          </div>
          {searchSource && (
            <div className={`self-start rounded-full border px-3 py-1 text-xs font-medium ${getSourceTone(searchSource)}`}>
              {getSourceLabel(searchSource)}
            </div>
          )}
        </div>

        {propertyAddress == null || propertyAddress.trim() === '' ? (
          <div className="px-5 py-5 text-sm text-slate-500">
            Select a property with an address to search for local maintenance providers.
          </div>
        ) : loadingDiscoveries ? (
          <div className="grid gap-3 p-5 pt-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="h-4 w-2/3 animate-pulse rounded bg-slate-200" />
                <div className="mt-3 h-3 w-1/2 animate-pulse rounded bg-slate-200" />
                <div className="mt-4 h-16 animate-pulse rounded-xl bg-slate-200" />
              </div>
            ))}
          </div>
        ) : discoveryError ? (
          <div className="px-5 py-5 text-sm text-red-600">{discoveryError}</div>
        ) : visibleDiscoveredProviders.length === 0 ? (
          <div className="px-5 py-5 text-sm text-slate-500">
            No unapproved discovery results are currently available for {selectedCategory}. Try refreshing or switch to another trade.
          </div>
        ) : (
          <div className="grid gap-3 p-5 pt-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleDiscoveredProviders.map((provider) => (
              <div key={buildProviderMatchKey(provider, selectedCategory)} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">{provider.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span>{selectedCategoryOption.icon} {selectedCategory}</span>
                      {provider.businessStatus && <span>{provider.businessStatus}</span>}
                      {provider.openNow === true && <span className="text-emerald-600">Open now</span>}
                    </div>
                  </div>
                  {typeof provider.combinedScore === 'number' && (
                    <span className="rounded-full bg-violet-100 px-2 py-1 text-[11px] font-semibold text-violet-700">
                      Rank {provider.combinedScore}
                    </span>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-700">
                    ★ {formatRating(provider.rating)}
                  </span>
                  {provider.reviewCount ? (
                    <span>{provider.reviewCount.toLocaleString()} reviews</span>
                  ) : (
                    <span>Contact details verified</span>
                  )}
                  {provider.searchSource && (
                    <span className={`rounded-full border px-2 py-1 ${getSourceTone(provider.searchSource)}`}>
                      {getSourceLabel(provider.searchSource)}
                    </span>
                  )}
                </div>

                <div className="mt-3 space-y-1 text-xs text-slate-600">
                  {provider.phone ? (
                    <a href={`tel:${provider.phone}`} className="block font-medium text-blue-600 hover:text-blue-700">
                      {provider.phone}
                    </a>
                  ) : (
                    <div className="text-amber-700">Phone not found yet</div>
                  )}
                  {provider.address && <div className="line-clamp-2">{provider.address}</div>}
                  {provider.website && (
                    <a href={provider.website} target="_blank" rel="noreferrer" className="block truncate text-blue-600 hover:text-blue-700">
                      {provider.website}
                    </a>
                  )}
                  {provider.snippet && <div className="line-clamp-2 text-slate-500">{provider.snippet}</div>}
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleApproveProvider(provider)}
                    disabled={!provider.phone}
                    className="rounded-full bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Approve to trusted
                  </button>
                  {provider.googleMapsUrl && (
                    <a
                      href={provider.googleMapsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                    >
                      Map
                    </a>
                  )}
                  {provider.website && (
                    <a
                      href={provider.website}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100"
                    >
                      Website
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-xs text-slate-500">
          {searchSource === 'regional_seed'
            ? 'Live search was unavailable for this category/location, so this list falls back to a curated regional directory. Verify details before dispatching.'
            : 'Always verify insurance, licensing, and urgent-service availability before dispatching.'}
        </div>
      </div>
    </div>
  );
}
