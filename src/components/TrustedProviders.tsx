import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getUserPreference, setUserPreference } from '../services/userPreferencesService';
import { extractStateCode } from '../services/regionalDataService';

export interface TrustedProvider {
  id: string;
  name: string;
  phone: string;
  email?: string;
  website?: string;
  categories: string[];  // Which maintenance categories they handle
  notes?: string;
  addedAt: string;
  propertyScopeId?: string;
  propertyAddress?: string;
  region?: string;
}

const MAINTENANCE_CATEGORIES = [
  'Plumbing',
  'Electrical',
  'HVAC',
  'Appliances',
  'Structural',
  'Pest Control',
  'Lock/Security',
  'General Repair',
  'Roofing',
  'Landscaping',
  'Other'
];

const STORAGE_KEY = 'trustedProviders';
const PREFERENCE_FIELD = 'trustedProviders';

function emitTrustedProvidersUpdated(providers: TrustedProvider[]) {
  window.dispatchEvent(new CustomEvent('trustedProvidersUpdated', { detail: providers }));
}

function buildTrustedProviderRecord(input: TrustedProvider): TrustedProvider {
  const record: TrustedProvider = {
    id: input.id,
    name: input.name,
    phone: input.phone,
    categories: input.categories,
    addedAt: input.addedAt
  };

  if (input.email) record.email = input.email;
  if (input.website) record.website = input.website;
  if (input.notes) record.notes = input.notes;
  if (input.propertyScopeId) record.propertyScopeId = input.propertyScopeId;
  if (input.propertyAddress) record.propertyAddress = input.propertyAddress;
  if (input.region) record.region = input.region;

  return record;
}

export async function getTrustedProviders(userId?: string): Promise<TrustedProvider[]> {
  if (!userId) {
    return [];
  }

  const providers = await getUserPreference<TrustedProvider[]>(userId, PREFERENCE_FIELD, []);
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
  }
  return providers;
}

export async function saveTrustedProviders(userId: string, providers: TrustedProvider[]) {
  const sanitizedProviders = providers.map(buildTrustedProviderRecord);
  const result = await setUserPreference(userId, PREFERENCE_FIELD, sanitizedProviders);
  if (result.success && typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY);
    emitTrustedProvidersUpdated(sanitizedProviders);
  }
  return result;
}

export async function findTrustedProviderForCategory(
  userId: string | undefined,
  category: string,
  options?: { propertyScopeId?: string; region?: string }
): Promise<TrustedProvider | null> {
  const providers = await getTrustedProviders(userId);
  const normalizedCategory = category.toLowerCase().trim();

  const categoryMatches = providers.filter((provider) =>
    provider.categories.some((entry) =>
      entry.toLowerCase().includes(normalizedCategory) || normalizedCategory.includes(entry.toLowerCase())
    )
  );

  if (options?.propertyScopeId) {
    const propertyMatch = categoryMatches.find((provider) => provider.propertyScopeId === options.propertyScopeId);
    if (propertyMatch) {
      return propertyMatch;
    }

    if (options.region) {
      const regionMatch = categoryMatches.find((provider) =>
        !provider.propertyScopeId && provider.region?.toUpperCase() === options.region?.toUpperCase()
      );
      if (regionMatch) {
        return regionMatch;
      }
    }

    return null;
  }

  return categoryMatches[0] || null;
}

interface TrustedProvidersProps {
  propertyScopeId?: string;
  propertyAddress?: string;
  region?: string;
}

export default function TrustedProviders({
  propertyScopeId,
  propertyAddress,
  region: regionProp
}: TrustedProvidersProps) {
  const { user } = useAuth();
  const [providers, setProviders] = useState<TrustedProvider[]>([]);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const resolvedRegion = regionProp || (propertyAddress ? extractStateCode(propertyAddress) : '');

  // Form state
  const [formName, setFormName] = useState('');
  const [formPhone, setFormPhone] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formWebsite, setFormWebsite] = useState('');
  const [formCategories, setFormCategories] = useState<string[]>([]);
  const [formNotes, setFormNotes] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async () => {
      if (!user?.id) {
        setProviders([]);
        return;
      }

      const storedProviders = await getTrustedProviders(user.id);
      const scopedProviders = propertyScopeId
        ? storedProviders.filter((provider) => provider.propertyScopeId === propertyScopeId)
        : storedProviders;

      if (!cancelled) {
        setProviders(scopedProviders);
      }
    };

    void loadProviders();

    const handleUpdate = (event: CustomEvent<TrustedProvider[]>) => {
      if (!cancelled) {
        const updatedProviders = propertyScopeId
          ? event.detail.filter((provider) => provider.propertyScopeId === propertyScopeId)
          : event.detail;
        setProviders(updatedProviders);
      }
    };
    window.addEventListener('trustedProvidersUpdated', handleUpdate as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener('trustedProvidersUpdated', handleUpdate as EventListener);
    };
  }, [user?.id, propertyScopeId]);

  const resetForm = () => {
    setFormName('');
    setFormPhone('');
    setFormEmail('');
    setFormWebsite('');
    setFormCategories([]);
    setFormNotes('');
    setIsAddingNew(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formPhone.trim() || formCategories.length === 0) {
      return;
    }

    if (!user?.id) {
      setSaveError('Sign in to save trusted providers to Firestore.');
      return;
    }

    setSaveError(null);

    const newProvider = buildTrustedProviderRecord({
      id: editingId || `tp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: formName.trim(),
      phone: formPhone.trim(),
      email: formEmail.trim() || undefined,
      website: formWebsite.trim() || undefined,
      categories: formCategories,
      notes: formNotes.trim() || undefined,
      addedAt: editingId ? providers.find((provider) => provider.id === editingId)?.addedAt || new Date().toISOString() : new Date().toISOString(),
      propertyScopeId: propertyScopeId || undefined,
      propertyAddress: propertyAddress || undefined,
      region: resolvedRegion || undefined
    });

    const allProviders = await getTrustedProviders(user.id);
    let updatedProviders: TrustedProvider[];

    if (editingId) {
      updatedProviders = allProviders.map((provider) => provider.id === editingId ? newProvider : provider);
    } else {
      updatedProviders = [...allProviders, newProvider];
    }

    const scopedProviders = propertyScopeId
      ? updatedProviders.filter((provider) => provider.propertyScopeId === propertyScopeId)
      : updatedProviders;

    setProviders(scopedProviders);
    const result = await saveTrustedProviders(user.id, updatedProviders);
    if (!result.success) {
      setSaveError(result.error || 'Failed to save trusted providers');
      return;
    }

    resetForm();
  };

  const handleEdit = (provider: TrustedProvider) => {
    setEditingId(provider.id);
    setFormName(provider.name);
    setFormPhone(provider.phone);
    setFormEmail(provider.email || '');
    setFormWebsite(provider.website || '');
    setFormCategories(provider.categories);
    setFormNotes(provider.notes || '');
    setIsAddingNew(true);
  };

  const handleDelete = async (id: string) => {
    if (!user?.id) {
      setSaveError('Sign in to remove trusted providers.');
      return;
    }

    const allProviders = await getTrustedProviders(user.id);
    const updatedProviders = allProviders.filter((provider) => provider.id !== id);
    const scopedProviders = propertyScopeId
      ? updatedProviders.filter((provider) => provider.propertyScopeId === propertyScopeId)
      : updatedProviders;

    setProviders(scopedProviders);
    const result = await saveTrustedProviders(user.id, updatedProviders);
    if (!result.success) {
      setSaveError(result.error || 'Failed to remove trusted provider');
    }
  };

  const toggleCategory = (category: string) => {
    setFormCategories((previous) =>
      previous.includes(category)
        ? previous.filter((entry) => entry !== category)
        : [...previous, category]
    );
  };

  const getCategoryIcon = (category: string) => {
    const icons: Record<string, string> = {
      'Plumbing': '🔧',
      'Electrical': '⚡',
      'HVAC': '❄️',
      'Appliances': '🔌',
      'Structural': '🏗️',
      'Pest Control': '🐜',
      'Lock/Security': '🔒',
      'General Repair': '🛠️',
      'Roofing': '🏠',
      'Landscaping': '🌳',
      'Other': '📋'
    };
    return icons[category] || '📋';
  };

  return (
    <div className="rounded-xl border bg-white overflow-hidden mb-10">
      <div className="px-4 py-4 border-b bg-gradient-to-r from-blue-50 to-indigo-50 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-gray-800 flex items-center gap-2">
            ⭐ Trusted Providers
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {propertyScopeId
              ? `Pre-approved contractors for ${propertyAddress || 'this property'}${resolvedRegion ? ` (${resolvedRegion})` : ''}`
              : 'Pre-approved contractors for maintenance categories • Auto-selected when matching requests arrive'}
          </div>
        </div>
        <button
          onClick={() => { resetForm(); setIsAddingNew(true); }}
          className="text-xs px-3 py-1.5 rounded border bg-white hover:bg-gray-50 transition-colors flex items-center gap-1"
        >
          <span>+</span> Add Provider
        </button>
      </div>

      {isAddingNew && (
        <div className="p-4 border-b bg-gray-50">
          <div className="text-sm font-medium text-gray-700 mb-3">
            {editingId ? 'Edit Trusted Provider' : 'Add New Trusted Provider'}
          </div>

          {propertyScopeId && (
            <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
              This provider will only be used for maintenance at {propertyAddress || 'this property'}
              {resolvedRegion ? ` in ${resolvedRegion}` : ''}.
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Company Name *</label>
              <input
                type="text"
                value={formName}
                onChange={(event) => setFormName(event.target.value)}
                placeholder="e.g., ABC Plumbing Co."
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Phone Number *</label>
              <input
                type="tel"
                value={formPhone}
                onChange={(event) => setFormPhone(event.target.value)}
                placeholder="e.g., 301-555-1234"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Email</label>
              <input
                type="email"
                value={formEmail}
                onChange={(event) => setFormEmail(event.target.value)}
                placeholder="e.g., contact@abcplumbing.com"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Website</label>
              <input
                type="url"
                value={formWebsite}
                onChange={(event) => setFormWebsite(event.target.value)}
                placeholder="e.g., https://abcplumbing.com"
                className="w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-xs text-gray-500 mb-2">Service Categories * (select all that apply)</label>
            <div className="flex flex-wrap gap-2">
              {MAINTENANCE_CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => toggleCategory(category)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    formCategories.includes(category)
                      ? 'bg-blue-100 border-blue-300 text-blue-700'
                      : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {getCategoryIcon(category)} {category}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <label className="block text-xs text-gray-500 mb-1">Notes (optional)</label>
            <textarea
              value={formNotes}
              onChange={(event) => setFormNotes(event.target.value)}
              placeholder="e.g., Mon-Fri 8am-6pm, available 24/7 for emergencies..."
              className="w-full rounded-md border px-3 py-2 text-sm"
              rows={2}
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!formName.trim() || !formPhone.trim() || formCategories.length === 0}
              className="px-4 py-2 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {editingId ? 'Save Changes' : 'Add Provider'}
            </button>
            <button
              onClick={resetForm}
              className="px-4 py-2 text-xs rounded-md border hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
          </div>
          {saveError && <div className="mt-3 text-xs text-red-600">{saveError}</div>}
        </div>
      )}

      <div className="divide-y divide-gray-100">
        {providers.length === 0 && !isAddingNew ? (
          <div className="p-8 text-center text-gray-500">
            <div className="text-2xl mb-2">⭐</div>
            <div className="text-sm">{user?.id ? 'No trusted providers yet' : 'Sign in to manage trusted providers'}</div>
            <div className="text-xs text-gray-400 mt-1">
              {user?.id
                ? propertyScopeId
                  ? 'Add local contractors you trust for this property'
                  : 'Add providers you trust for automatic selection on matching maintenance requests'
                : 'Trusted providers now persist to your Firestore profile'}
            </div>
          </div>
        ) : (
          providers.map((provider) => (
            <div key={provider.id} className="hover:bg-gray-50 transition-colors">
              <div
                className="px-4 py-3 cursor-pointer"
                onClick={() => setExpandedId(expandedId === provider.id ? null : provider.id)}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-900">{provider.name}</span>
                      <span className="text-xs text-gray-400">•</span>
                      <a
                        href={`tel:${provider.phone}`}
                        className="text-xs text-blue-600 hover:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {provider.phone}
                      </a>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {provider.categories.map((category) => (
                        <span
                          key={category}
                          className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700"
                        >
                          {getCategoryIcon(category)} {category}
                        </span>
                      ))}
                      {provider.region && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                          📍 {provider.region}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={(event) => { event.stopPropagation(); handleEdit(provider); }}
                      className="text-xs px-2 py-1 rounded border hover:bg-white transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={(event) => { event.stopPropagation(); handleDelete(provider.id); }}
                      className="text-xs px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                    >
                      Remove
                    </button>
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform ${expandedId === provider.id ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              </div>

              {expandedId === provider.id && (
                <div className="px-4 pb-4 border-t bg-gray-50">
                  <div className="mt-3 space-y-2 text-sm">
                    {provider.propertyAddress && (
                      <div>
                        <span className="text-gray-500">Property:</span>{' '}
                        <span className="text-gray-700">{provider.propertyAddress}</span>
                      </div>
                    )}
                    {provider.email && (
                      <div>
                        <span className="text-gray-500">Email:</span>{' '}
                        <a href={`mailto:${provider.email}`} className="text-blue-600 hover:underline">
                          {provider.email}
                        </a>
                      </div>
                    )}
                    {provider.website && (
                      <div>
                        <span className="text-gray-500">Website:</span>{' '}
                        <a href={provider.website} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                          {provider.website}
                        </a>
                      </div>
                    )}
                    {provider.notes && (
                      <div>
                        <span className="text-gray-500">Notes:</span>{' '}
                        <span className="text-gray-700">{provider.notes}</span>
                      </div>
                    )}
                    <div className="text-xs text-gray-400 pt-2">
                      Added: {new Date(provider.addedAt).toLocaleDateString()}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {providers.length > 0 && (
        <div className="px-4 py-3 bg-blue-50 border-t text-xs text-blue-700">
          💡 When a maintenance request matches a trusted provider&apos;s category{propertyScopeId ? ' for this property' : ''}, they are automatically selected instead of searching online.
        </div>
      )}
    </div>
  );
}
