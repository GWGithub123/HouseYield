/**
 * Absentee Owner Search Page
 * Find off-market investment opportunities by searching for properties
 * with absentee owners who may be motivated to sell at a discount.
 */

import { useState, useCallback, useEffect } from 'react';
import { 
  Search, 
  MapPin, 
  Building2, 
  Users, 
  TrendingUp, 
  Mail, 
  Clock,
  DollarSign,
  Home,
  Filter,
  Download,
  Save,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Map as MapIcon,
  Send,
  Sparkles
} from 'lucide-react';

// Components
import AbsenteeOutreachModal from '../components/AbsenteeOutreachModal';
import InsurancePremiumEstimatorCard from '../components/insurance/InsurancePremiumEstimatorCard';
import type { InsurancePremiumEstimate } from '../types/iot';
import { authenticatedFetch } from '../utils/authenticatedFetch';
import { getOpsBackendUrl } from '../utils/opsBackendUrl';
import { useAuth } from '../contexts/AuthContext';

// Types
interface AbsenteeOwner {
  name: string;
  name2?: string | null;
  isCorporate: boolean;
  mailingAddress: string;
  mailingCity?: string;
  mailingState?: string;
  mailingZip?: string;
}

interface MortgageInfo {
  lender?: string | { lastname?: string; city?: string; state?: string };
  amount: number;
  date?: string;
  loanType?: string;
  interestRate?: number;
  termMonths?: number;
  rateEstimated?: boolean;
}

interface AssumabilityInfo {
  assumable: 'likely' | 'possible' | 'unlikely' | 'unknown';
  confidence: 'high' | 'medium' | 'low' | 'none';
  reason: string;
  loanType: string;
  loanDate?: string;
  estimatedRate?: number;
  currentRate?: number;
  rateSavings?: number;
  attractiveness: 'very_attractive' | 'attractive' | 'somewhat_attractive' | 'not_attractive' | 'unknown';
  remainingBalance?: number;
  originalAmount?: number;
  monthsRemaining?: number;
  percentPaid?: number;
}

interface AbsenteeLead {
  attomId?: string;
  apn?: string;
  fips?: string;
  address: string;
  streetAddress?: string;
  city: string;
  state: string;
  zipCode: string;
  county?: string;
  propertyType: string;
  beds: number;
  baths: number;
  sqft: number;
  lotSizeAcres?: number;
  yearBuilt: number;
  propertyAge?: number;
  assessedValue: number;
  marketValue: number;
  lastSalePrice?: number;
  lastSaleDate?: string;
  owner: AbsenteeOwner;
  ownershipYears: number;
  likelyFreeAndClear: boolean;
  estimatedEquityPercent?: number;
  motivationScore: number;
  motivationFactors: string[];
  isOutOfState?: boolean;
  insuranceEstimate?: InsurancePremiumEstimate;
  mortgage?: MortgageInfo | null;
  assumability?: AssumabilityInfo | null;
  latitude?: number;
  longitude?: number;
  rentalConfidence?: number;
  rentalConfidenceLabel?: string;
  listedForRent?: boolean;
  everListedForRent?: boolean | null;
  listedInLast90Days?: boolean | null;
  listedInLast5Years?: boolean | null;
  lastListedDate?: string | null;
  ownerOccupied?: boolean | null;
  rentEstimate?: number | null;
  rentalSignals?: string[];
  grossYield?: number | null;
  ownerDistanceMiles?: number | null;
  ownerDistanceBand?: string | null;
  ownerPortfolioCount?: number | null;
  ownerPortfolioBand?: string | null;
  taxOverAssessmentFlag?: 'strong' | 'moderate' | 'none' | null;
  taxEquityExcessPct?: number | null;
  taxMarketExcessPct?: number | null;
  taxAnnualSavingsLow?: number | null;
  taxAnnualSavingsHigh?: number | null;
  taxJustifiedAssessment?: number | null;
  taxAppealDeadline?: string | null;
  taxOverAssessmentNarrative?: string | null;
  taxOverAssessmentConfidence?: string | null;
  taxCompCount?: number | null;
  taxOverAssessment?: Record<string, unknown> | null;
  leakRiskScore?: number;
  leakRiskLabel?: string;
  leakRiskSignals?: string[];
  protectionLeadScore?: number;
  dbId?: number;
}

interface MarketPreset {
  id: string;
  label: string;
  description: string;
  preferredSearchMode?: 'radius' | 'zips' | 'county';
  zips?: string[];
  defaultFilters?: {
    propertyType?: string;
    outOfStateOnly?: boolean;
    individualsOnly?: boolean;
    corporateOnly?: boolean;
    minYearsOwned?: number;
  };
}

interface SearchFilters {
  zipCode: string;
  county: string;
  lat: string;
  lng: string;
  radius: string;
  minValue: string;
  maxValue: string;
  minSqft: string;
  maxSqft: string;
  minYearsOwned: string;
  propertyType: string;
  corporateOnly: boolean;
  individualsOnly: boolean;
  freeAndClear: boolean;
  outOfStateOnly: boolean;
}

type SearchMode = 'acquisition' | 'iot_protection';
type SearchAreaMode = 'preset' | 'manual';

const BACKEND_URL = getOpsBackendUrl();

const DEFAULT_UMD_PRESET: MarketPreset = {
  id: 'umd_college_park',
  label: 'UMD / College Park',
  description: 'Mom-and-pop absentee SFR owners near College Park (excludes corporate apartments/condos)',
  preferredSearchMode: 'zips',
  zips: ['20740', '20737', '20770', '20781', '20782', '20783'],
  defaultFilters: {
    propertyType: 'SFR',
    individualsOnly: true,
    corporateOnly: false,
    outOfStateOnly: false,
    minYearsOwned: 0,
  },
};

function getRentalBadge(label?: string, score?: number) {
  if (!score && !label) return null;
  if (label === 'listed_for_rent') {
    return <span className="px-2 py-1 bg-emerald-100 text-emerald-800 text-xs font-semibold rounded-full">Listed for Rent{score != null ? ` (${score})` : ''}</span>;
  }
  if (label === 'likely_rental' || (score || 0) >= 70) {
    return <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs font-semibold rounded-full">Likely Rental{score != null ? ` (${score})` : ''}</span>;
  }
  if (label === 'possible_rental' || (score || 0) >= 45) {
    return <span className="px-2 py-1 bg-amber-100 text-amber-700 text-xs font-semibold rounded-full">Possible Rental{score != null ? ` (${score})` : ''}</span>;
  }
  return <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full">Unlikely Rental{score != null ? ` (${score})` : ''}</span>;
}

function getLeakRiskBadge(label?: string, score?: number) {
  if (!score && !label) return null;
  if (label === 'high' || (score || 0) >= 65) {
    return <span className="px-2 py-1 bg-rose-100 text-rose-700 text-xs font-semibold rounded-full">High Leak Risk</span>;
  }
  if (label === 'moderate' || (score || 0) >= 40) {
    return <span className="px-2 py-1 bg-orange-100 text-orange-700 text-xs font-semibold rounded-full">Moderate Leak Risk</span>;
  }
  return <span className="px-2 py-1 bg-slate-100 text-slate-600 text-xs font-semibold rounded-full">Low Leak Risk</span>;
}

function getTaxFlagBadge(flag?: string | null, savingsLow?: number | null) {
  if (flag !== 'strong' && flag !== 'moderate') return null;
  const savings = Number.isFinite(Number(savingsLow)) && Number(savingsLow) > 0
    ? ` · ~$${Math.round(Number(savingsLow)).toLocaleString()}/yr?`
    : '';
  if (flag === 'strong') {
    return (
      <span className="px-2 py-1 bg-amber-100 text-amber-900 text-xs font-semibold rounded-full">
        Tax review{savings}
      </span>
    );
  }
  return (
    <span className="px-2 py-1 bg-yellow-50 text-yellow-800 text-xs font-semibold rounded-full">
      Tax review{savings}
    </span>
  );
}

function formatSearchError(errorCode: string, message?: string) {
  if (errorCode === 'internal_staff_not_configured') {
    return 'Staff access is not configured on the backend. Add HOUSEYIELD_INTERNAL_STAFF_EMAILS to your Cloud Run service (or local .env), including your Firebase login email, then redeploy/restart.';
  }
  if (errorCode === 'forbidden') {
    return 'Your account is not on the internal staff allowlist. Add your Firebase email to HOUSEYIELD_INTERNAL_STAFF_EMAILS on the backend.';
  }
  if (errorCode === 'unauthorized' || errorCode === 'invalid_token') {
    return 'Your staff session expired. Sign out and sign back in to the ops console.';
  }
  return message || errorCode || 'Search failed';
}

const PROPERTY_TYPES = [
  { value: 'ALL', label: 'All property types' },
  { value: 'SFR', label: 'Single Family' },
  { value: 'CONDO', label: 'Condo/Townhouse' },
  { value: 'MFR', label: 'Multi-Family (2-4 units)' },
  { value: 'APARTMENT', label: 'Apartment (5+ units)' },
  { value: 'LAND', label: 'Vacant Land' },
  { value: 'COMMERCIAL', label: 'Commercial' },
];

function getMotivationColor(score: number): string {
  if (score >= 70) return 'text-green-600 bg-green-100';
  if (score >= 50) return 'text-yellow-600 bg-yellow-100';
  if (score >= 30) return 'text-orange-600 bg-orange-100';
  return 'text-gray-600 bg-gray-100';
}

function getPriorityBadge(score: number) {
  if (score >= 70) {
    return <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-semibold rounded-full">🔥 HOT LEAD</span>;
  }
  if (score >= 50) {
    return <span className="px-2 py-1 bg-yellow-100 text-yellow-700 text-xs font-semibold rounded-full">⭐ WARM</span>;
  }
  if (score >= 30) {
    return <span className="px-2 py-1 bg-orange-100 text-orange-700 text-xs font-semibold rounded-full">📋 NURTURE</span>;
  }
  return <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs font-semibold rounded-full">👁 MONITOR</span>;
}

export default function AbsenteeOwnerSearch() {
  const { isAuthenticated, loading: authLoading } = useAuth();
  const [searchMode, setSearchMode] = useState<SearchMode>('iot_protection');
  const [searchAreaMode, setSearchAreaMode] = useState<SearchAreaMode>('preset');
  const [marketPresets, setMarketPresets] = useState<MarketPreset[]>([DEFAULT_UMD_PRESET]);
  const [selectedPreset, setSelectedPreset] = useState('umd_college_park');
  const [presetSearchMode, setPresetSearchMode] = useState<'radius' | 'zips' | 'county'>('zips');
  const [enrichOnSearch, setEnrichOnSearch] = useState(true);
  const [includeTaxOverAssessment, setIncludeTaxOverAssessment] = useState(false);
  const [likelyRentalsOnly, setLikelyRentalsOnly] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({
    zipCode: '',
    county: '',
    lat: '',
    lng: '',
    radius: '2.5',
    minValue: '',
    maxValue: '',
    minSqft: '',
    maxSqft: '',
    minYearsOwned: '',
    propertyType: 'SFR',
    corporateOnly: false,
    individualsOnly: true,
    freeAndClear: false,
    outOfStateOnly: false,
  });

  const [leads, setLeads] = useState<AbsenteeLead[]>([]);
  const [selectedLeads, setSelectedLeads] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchStats, setSearchStats] = useState<{
    totalFound: number;
    totalQualified: number;
    cache?: {
      searchCacheHit?: boolean;
      searchCacheHits?: number;
      processedLeadCacheHits?: number;
      enrichmentCacheHits?: number;
    };
    persist?: { saved?: number; inserted?: number; updated?: number; campaignName?: string; error?: string };
    enrichment?: { enrichedCount?: number; enrichmentCacheHits?: number };
  } | null>(null);
  const [showFilters, setShowFilters] = useState(true);
  const [expandedLead, setExpandedLead] = useState<string | null>(null);
  const [savingLeads, setSavingLeads] = useState(false);
  const [campaignName, setCampaignName] = useState('UMD Remote Protection');
  
  // Outreach modal state
  const [outreachModalOpen, setOutreachModalOpen] = useState(false);
  const [selectedLeadForOutreach, setSelectedLeadForOutreach] = useState<AbsenteeLead | null>(null);
  const [outreachPurpose, setOutreachPurpose] = useState<SearchMode>('iot_protection');

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      return;
    }

    authenticatedFetch(`${BACKEND_URL}/api/internal/staff-check`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.ok) {
          setError(formatSearchError(data.error, data.message));
        }
      })
      .catch(() => {
        // Staff check unavailable until backend restarts with latest routes
      });

    authenticatedFetch(`${BACKEND_URL}/api/internal/market-presets`)
      .then((response) => response.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.presets) && data.presets.length) {
          setMarketPresets(data.presets);
        }
      })
      .catch(() => {
        // Fallback preset already loaded
      });
  }, [authLoading, isAuthenticated]);

  const applyPresetDefaults = useCallback((presetId: string) => {
    const preset = marketPresets.find((entry) => entry.id === presetId) || DEFAULT_UMD_PRESET;
    setPresetSearchMode(preset.preferredSearchMode || 'zips');
    setFilters((current) => ({
      ...current,
      propertyType: preset.defaultFilters?.propertyType || current.propertyType,
      outOfStateOnly: preset.defaultFilters?.outOfStateOnly ?? current.outOfStateOnly,
      individualsOnly: preset.defaultFilters?.individualsOnly ?? current.individualsOnly,
      corporateOnly: preset.defaultFilters?.corporateOnly ?? false,
      minYearsOwned: preset.defaultFilters?.minYearsOwned
        ? String(preset.defaultFilters.minYearsOwned)
        : '',
    }));
  }, [marketPresets]);

  useEffect(() => {
    if (searchAreaMode === 'preset') {
      applyPresetDefaults(selectedPreset);
    }
  }, [selectedPreset, searchAreaMode, applyPresetDefaults]);

  // Open outreach modal for a specific lead
  const handleOpenOutreach = (lead: AbsenteeLead, purpose: SearchMode = searchMode) => {
    setSelectedLeadForOutreach(lead);
    setOutreachPurpose(purpose);
    setOutreachModalOpen(true);
  };

  // Handle when email is sent successfully
  const handleEmailSent = async (lead: AbsenteeLead) => {
    if (!lead.dbId) return;
    try {
      await authenticatedFetch(`${BACKEND_URL}/api/attom/absentee-leads/${lead.dbId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'contacted' }),
      });
    } catch (err) {
      console.warn('Failed to update lead status after send:', err);
    }
  };

  const handleSearch = useCallback(async () => {
    if (authLoading || !isAuthenticated) {
      setError('Sign in to the ops console before searching.');
      return;
    }

    if (searchAreaMode === 'manual' && !filters.zipCode && !filters.county && !(filters.lat && filters.lng)) {
      setError('Please enter a ZIP code, county, or lat/lng to search');
      return;
    }

    setLoading(true);
    setError(null);
    setLeads([]);
    setSearchStats(null);
    setSelectedLeads(new Set());

    try {
      const params = new URLSearchParams();

      if (searchAreaMode === 'preset') {
        params.set('preset', selectedPreset);
        params.set('searchMode', presetSearchMode);
      } else {
        if (filters.zipCode) params.set('zipCode', filters.zipCode);
        if (filters.county) params.set('county', filters.county);
        if (filters.lat && filters.lng) {
          params.set('lat', filters.lat);
          params.set('lng', filters.lng);
          if (filters.radius) params.set('radius', filters.radius);
        }
      }

      if (filters.minValue) params.set('minValue', filters.minValue);
      if (filters.maxValue) params.set('maxValue', filters.maxValue);
      if (filters.minSqft) params.set('minSqft', filters.minSqft);
      if (filters.maxSqft) params.set('maxSqft', filters.maxSqft);
      if (filters.minYearsOwned) params.set('minYearsOwned', filters.minYearsOwned);
      if (filters.propertyType && filters.propertyType !== 'ALL') {
        params.set('propertyType', filters.propertyType);
      }
      if (filters.corporateOnly) params.set('corporateOnly', 'true');
      if (filters.individualsOnly) params.set('individualsOnly', 'true');
      if (filters.freeAndClear) params.set('freeAndClear', 'true');
      if (filters.outOfStateOnly) params.set('outOfStateOnly', 'true');
      if (enrichOnSearch) {
        params.set('enrich', 'true');
        params.set('enrichLimit', includeTaxOverAssessment ? '10' : '25');
        if (includeTaxOverAssessment) {
          params.set('includeTaxOverAssessment', 'true');
        }
      }
      if (likelyRentalsOnly) params.set('likelyRentalsOnly', 'true');
      params.set('autoSave', 'true');
      if (campaignName) params.set('campaignName', campaignName);

      const response = await authenticatedFetch(`${BACKEND_URL}/api/attom/absentee-search?${params.toString()}`);
      const rawText = await response.text();
      let data: any = null;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        throw new Error(
          response.ok
            ? 'Search returned invalid JSON (backend may have restarted mid-request). Try again.'
            : `Search failed (${response.status}). Backend may be restarting — wait a few seconds and retry.`
        );
      }

      if (!response.ok || !data?.ok) {
        throw new Error(formatSearchError(data?.error, data?.error || data?.message || `HTTP ${response.status}`));
      }

      const properties = Array.isArray(data.properties) ? data.properties : [];
      setLeads(properties.map((lead: AbsenteeLead) => ({
        ...lead,
        motivationFactors: Array.isArray(lead.motivationFactors) ? lead.motivationFactors : [],
      })));
      setSearchStats({
        totalFound: data.totalFound ?? 0,
        totalQualified: data.totalQualified ?? properties.length,
        cache: data.cache || undefined,
        persist: data.persist || undefined,
        enrichment: data.enrichment || undefined,
      });

      if (properties.length === 0) {
        setError(
          `Found ${data.totalFound ?? 0} absentee properties, but none matched the current filters (SFR + individuals). Try Condo/Townhouse or turn off Individuals only.`
        );
      }
    } catch (err: any) {
      setError(err.message || 'Failed to search for absentee owners');
    } finally {
      setLoading(false);
    }
  }, [authLoading, filters, isAuthenticated, searchAreaMode, selectedPreset, presetSearchMode, enrichOnSearch, includeTaxOverAssessment, likelyRentalsOnly, campaignName]);

  const handleSaveLeads = useCallback(async () => {
    const leadsToSave = selectedLeads.size > 0 
      ? leads.filter(l => selectedLeads.has(l.address))
      : leads;

    if (leadsToSave.length === 0) {
      setError('No leads to save');
      return;
    }

    setSavingLeads(true);
    try {
      const response = await authenticatedFetch(`${BACKEND_URL}/api/attom/absentee-leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leads: leadsToSave,
          campaignName: campaignName || `Search-${new Date().toLocaleDateString()}`
        })
      });

      const data = await response.json();
      if (!data.ok) {
        throw new Error(data.error);
      }

      const savedByAttom = new Map(
        (data.savedLeads || []).map((row: { attom_id?: string; id: number; address: string }) => [
          row.attom_id || row.address,
          row.id,
        ]),
      );

      setLeads((current) => current.map((lead) => ({
        ...lead,
        dbId: savedByAttom.get(lead.attomId || lead.address) || lead.dbId,
      })));

      alert(`Saved ${data.saved ?? data.inserted} leads to campaign "${data.campaignName || campaignName || 'default'}"${data.updated ? ` (${data.inserted || 0} new, ${data.updated} updated)` : ''}`);
      setSelectedLeads(new Set());
    } catch (err: any) {
      setError(err.message || 'Failed to save leads');
    } finally {
      setSavingLeads(false);
    }
  }, [leads, selectedLeads, campaignName]);

  const handleExportCSV = useCallback(() => {
    const leadsToExport = selectedLeads.size > 0 
      ? leads.filter(l => selectedLeads.has(l.address))
      : leads;

    if (leadsToExport.length === 0) return;

    const headers = [
      'Address', 'City', 'State', 'ZIP', 'Property Type',
      'Beds', 'Baths', 'Sqft', 'Year Built',
      'Assessed Value', 'Market Value',
      'Owner Name', 'Corporate', 'Mailing Address',
      'Owner Distance Miles', 'Portfolio Count', 'Portfolio Band',
      'Years Owned', 'Free & Clear', 'Motivation Score', 'Protection Score',
      'Rental Confidence', 'Listed 90d', 'Listed 5yr', 'Rent Estimate', 'Gross Yield', 'Leak Risk Score',
      'Motivation Factors'
    ];

    const rows = leadsToExport.map(lead => [
      lead.address,
      lead.city,
      lead.state,
      lead.zipCode,
      lead.propertyType,
      lead.beds,
      lead.baths,
      lead.sqft,
      lead.yearBuilt,
      lead.assessedValue,
      lead.marketValue,
      lead.owner.name,
      lead.owner.isCorporate ? 'Yes' : 'No',
      lead.owner.mailingAddress,
      lead.ownerDistanceMiles ?? '',
      lead.ownerPortfolioCount ?? '',
      lead.ownerPortfolioBand || '',
      lead.ownershipYears,
      lead.likelyFreeAndClear ? 'Yes' : 'No',
      lead.motivationScore,
      lead.protectionLeadScore || '',
      lead.rentalConfidence || '',
      lead.listedInLast90Days ? 'Yes' : '',
      lead.listedInLast5Years ? 'Yes' : '',
      lead.rentEstimate || '',
      lead.grossYield || '',
      lead.leakRiskScore || '',
      lead.motivationFactors?.join('; ') || ''
    ]);

    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${v}"`).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `absentee-leads-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [leads, selectedLeads]);

  const toggleLeadSelection = (address: string) => {
    const newSelected = new Set(selectedLeads);
    if (newSelected.has(address)) {
      newSelected.delete(address);
    } else {
      newSelected.add(address);
    }
    setSelectedLeads(newSelected);
  };

  const selectAllLeads = () => {
    if (selectedLeads.size === leads.length) {
      setSelectedLeads(new Set());
    } else {
      setSelectedLeads(new Set(leads.map(l => l.address)));
    }
  };

  return (
    <div className="min-h-screen bg-gray-50" data-voice-id="absentee-search-page">
      {/* Header */}
      <div className="bg-gradient-to-r from-purple-700 to-indigo-800 text-white" data-voice-id="absentee-header">
        <div className="max-w-7xl mx-auto px-4 py-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-white/20 rounded-lg">
              <Users className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-bold">Absentee Owner Search</h1>
          </div>
          <p className="text-purple-200 ml-12">
            {searchMode === 'iot_protection'
              ? 'Find remote owners for HouseYield water protection — with estimated insurance savings per property'
              : 'Find off-market investment opportunities with motivated absentee owners'}
          </p>
          <div className="ml-12 mt-4 inline-flex rounded-lg bg-white/10 p-1">
            <button
              type="button"
              onClick={() => setSearchMode('iot_protection')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                searchMode === 'iot_protection' ? 'bg-white text-purple-800' : 'text-purple-100 hover:bg-white/10'
              }`}
            >
              Remote Water Protection
            </button>
            <button
              type="button"
              onClick={() => setSearchMode('acquisition')}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                searchMode === 'acquisition' ? 'bg-white text-purple-800' : 'text-purple-100 hover:bg-white/10'
              }`}
            >
              Acquisition Leads
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Search Filters */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-6" data-voice-id="absentee-filters">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="w-full px-6 py-4 flex items-center justify-between text-left"
            data-voice-id="toggle-filters-btn"
          >
            <div className="flex items-center gap-2">
              <Filter className="h-5 w-5 text-gray-500" />
              <span className="font-semibold text-gray-800">Search Filters</span>
            </div>
            {showFilters ? <ChevronUp className="h-5 w-5 text-gray-400" /> : <ChevronDown className="h-5 w-5 text-gray-400" />}
          </button>

          {showFilters && (
            <div className="px-6 pb-6 border-t border-gray-100">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <MapPin className="inline h-4 w-4 mr-1" />
                    Market Area
                  </label>
                  <div className="flex flex-wrap gap-2 mb-3">
                    <button
                      type="button"
                      onClick={() => setSearchAreaMode('preset')}
                      className={`rounded-lg px-3 py-2 text-sm font-medium ${
                        searchAreaMode === 'preset' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      Preset
                    </button>
                    <button
                      type="button"
                      onClick={() => setSearchAreaMode('manual')}
                      className={`rounded-lg px-3 py-2 text-sm font-medium ${
                        searchAreaMode === 'manual' ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      Manual
                    </button>
                  </div>

                  {searchAreaMode === 'preset' ? (
                    <div className="space-y-3">
                      <select
                        value={selectedPreset}
                        onChange={(e) => setSelectedPreset(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      >
                        {marketPresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>{preset.label}</option>
                        ))}
                      </select>
                      <select
                        value={presetSearchMode}
                        onChange={(e) => setPresetSearchMode(e.target.value as 'radius' | 'zips' | 'county')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      >
                        <option value="zips">ZIP list (recommended for SFRs)</option>
                        <option value="radius">Radius around campus</option>
                        <option value="county">Prince George&apos;s County</option>
                      </select>
                      <p className="text-xs text-gray-500">
                        {marketPresets.find((preset) => preset.id === selectedPreset)?.description}
                      </p>
                      {presetSearchMode === 'zips' ? (
                        <p className="text-xs text-emerald-700">
                          Searching ZIPs:{' '}
                          {(marketPresets.find((preset) => preset.id === selectedPreset)?.zips
                            || DEFAULT_UMD_PRESET.zips
                            || []).join(', ')}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <input
                        type="text"
                        value={filters.zipCode}
                        onChange={(e) => setFilters({ ...filters, zipCode: e.target.value })}
                        placeholder="ZIP code"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        data-voice-id="absentee-zipcode-input"
                      />
                      <input
                        type="text"
                        value={filters.county}
                        onChange={(e) => setFilters({ ...filters, county: e.target.value })}
                        placeholder="County FIPS (e.g. 24033)"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      />
                      <div className="grid grid-cols-3 gap-2">
                        <input
                          type="text"
                          value={filters.lat}
                          onChange={(e) => setFilters({ ...filters, lat: e.target.value })}
                          placeholder="Lat"
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                        />
                        <input
                          type="text"
                          value={filters.lng}
                          onChange={(e) => setFilters({ ...filters, lng: e.target.value })}
                          placeholder="Lng"
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                        />
                        <input
                          type="text"
                          value={filters.radius}
                          onChange={(e) => setFilters({ ...filters, radius: e.target.value })}
                          placeholder="Radius mi"
                          className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Property Type */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Building2 className="inline h-4 w-4 mr-1" />
                    Property Type
                  </label>
                  <select
                    value={filters.propertyType}
                    onChange={(e) => setFilters({ ...filters, propertyType: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                    data-voice-id="absentee-property-type"
                  >
                    {PROPERTY_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>

                {/* Min Value */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <DollarSign className="inline h-4 w-4 mr-1" />
                    Min Value
                  </label>
                  <input
                    type="number"
                    value={filters.minValue}
                    onChange={(e) => setFilters({ ...filters, minValue: e.target.value })}
                    placeholder="e.g., 200000"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                  />
                </div>

                {/* Max Value */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <DollarSign className="inline h-4 w-4 mr-1" />
                    Max Value
                  </label>
                  <input
                    type="number"
                    value={filters.maxValue}
                    onChange={(e) => setFilters({ ...filters, maxValue: e.target.value })}
                    placeholder="e.g., 500000"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                  />
                </div>

                {/* Min Sqft */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Home className="inline h-4 w-4 mr-1" />
                    Min Sqft
                  </label>
                  <input
                    type="number"
                    value={filters.minSqft}
                    onChange={(e) => setFilters({ ...filters, minSqft: e.target.value })}
                    placeholder="e.g., 1500"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                  />
                </div>

                {/* Min Years Owned */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    <Clock className="inline h-4 w-4 mr-1" />
                    Min Years Owned
                  </label>
                  <input
                    type="number"
                    value={filters.minYearsOwned}
                    onChange={(e) => setFilters({ ...filters, minYearsOwned: e.target.value })}
                    placeholder="e.g., 10"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                  />
                </div>

                {/* Checkboxes */}
                <div className="flex flex-col gap-2 justify-center">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.individualsOnly}
                      onChange={(e) => setFilters({
                        ...filters,
                        individualsOnly: e.target.checked,
                        corporateOnly: e.target.checked ? false : filters.corporateOnly,
                      })}
                      className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                    />
                    <span className="text-sm text-gray-700">Individuals only (mom &amp; pop)</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.corporateOnly}
                      onChange={(e) => setFilters({
                        ...filters,
                        corporateOnly: e.target.checked,
                        individualsOnly: e.target.checked ? false : filters.individualsOnly,
                      })}
                      className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                    />
                    <span className="text-sm text-gray-700">Corporate Owners Only</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.freeAndClear}
                      onChange={(e) => setFilters({ ...filters, freeAndClear: e.target.checked })}
                      className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                    />
                    <span className="text-sm text-gray-700">Free & Clear Only</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filters.outOfStateOnly}
                      onChange={(e) => setFilters({ ...filters, outOfStateOnly: e.target.checked })}
                      className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                    />
                    <span className="text-sm text-gray-700">Out-of-State Owners Only</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={enrichOnSearch}
                      onChange={(e) => setEnrichOnSearch(e.target.checked)}
                      className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                    />
                    <span className="text-sm text-gray-700">Enrich with RentCast + leak risk</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={includeTaxOverAssessment}
                      onChange={(e) => setIncludeTaxOverAssessment(e.target.checked)}
                      disabled={!enrichOnSearch}
                      className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500 disabled:opacity-50"
                    />
                    <span className="text-sm text-gray-700">
                      Tax assessment screen (API-heavy — top 10)
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={likelyRentalsOnly}
                      onChange={(e) => setLikelyRentalsOnly(e.target.checked)}
                      className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                    />
                    <span className="text-sm text-gray-700">Likely rentals only</span>
                  </label>
                </div>

                {/* Search Button */}
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={handleSearch}
                    disabled={loading}
                    className="w-full px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white font-semibold rounded-lg flex items-center justify-center gap-2 disabled:opacity-50"
                    data-voice-id="search-absentee-btn"
                  >
                    {loading ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" />
                        Searching...
                      </>
                    ) : (
                      <>
                        <Search className="h-5 w-5" />
                        Search Absentee Owners
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
            <AlertCircle className="h-5 w-5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Results Header */}
        {searchStats && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-6">
                <div>
                  <span className="text-3xl font-bold text-purple-600">{searchStats.totalQualified}</span>
                  <span className="text-gray-500 ml-2">qualified leads</span>
                </div>
                <div className="text-sm text-gray-500">
                  ({searchStats.totalFound} total absentee properties found)
                  {searchStats.cache && (searchStats.cache.searchCacheHit || searchStats.cache.searchCacheHits || searchStats.cache.processedLeadCacheHits || searchStats.cache.enrichmentCacheHits) ? (
                    <span className="ml-2 text-emerald-700">
                      · cached (
                      {(searchStats.cache.searchCacheHit ? 1 : (searchStats.cache.searchCacheHits || 0))} ATTOM geo
                      , {searchStats.cache.processedLeadCacheHits || 0} leads
                      {searchStats.cache.enrichmentCacheHits ? `, ${searchStats.cache.enrichmentCacheHits} RentCast` : ''}
                      )
                    </span>
                  ) : null}
                  {searchStats.persist?.saved != null ? (
                    <span className="ml-2 text-blue-700">
                      · saved {searchStats.persist.saved} to “{searchStats.persist.campaignName || campaignName}”
                      {searchStats.persist.inserted || searchStats.persist.updated
                        ? ` (${searchStats.persist.inserted || 0} new, ${searchStats.persist.updated || 0} updated)`
                        : ''}
                      {' · '}
                      <a
                        href={`/saved-leads?campaign=${encodeURIComponent(searchStats.persist.campaignName || campaignName)}`}
                        className="underline hover:text-blue-900"
                      >
                        View saved leads
                      </a>
                    </span>
                  ) : null}
                  {searchStats.persist?.error ? (
                    <span className="ml-2 text-amber-700">· save failed: {searchStats.persist.error}</span>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="Campaign name (optional)"
                  className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500"
                />
                <button
                  onClick={handleSaveLeads}
                  disabled={savingLeads || leads.length === 0}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg flex items-center gap-2 disabled:opacity-50"
                  data-voice-id="save-leads-btn"
                >
                  {savingLeads ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save {selectedLeads.size > 0 ? `${selectedLeads.size} Selected` : 'All'}
                </button>
                <button
                  onClick={handleExportCSV}
                  disabled={leads.length === 0}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg flex items-center gap-2 disabled:opacity-50"
                  data-voice-id="export-leads-btn"
                >
                  <Download className="h-4 w-4" />
                  Export CSV
                </button>
              </div>
            </div>

            {/* Selection Controls */}
            {leads.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-100 flex items-center gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedLeads.size === leads.length}
                    onChange={selectAllLeads}
                    className="w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                  />
                  <span className="text-sm text-gray-600">Select All</span>
                </label>
                {selectedLeads.size > 0 && (
                  <span className="text-sm text-purple-600 font-medium">
                    {selectedLeads.size} selected
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Results Grid */}
        {leads.length > 0 && (
          <div className="grid gap-4">
            {leads.map((lead) => (
              <div
                key={lead.address}
                className={`bg-white rounded-xl shadow-sm border transition-all ${
                  selectedLeads.has(lead.address) ? 'border-purple-400 ring-2 ring-purple-100' : 'border-gray-200'
                }`}
              >
                {/* Lead Header */}
                <div className="p-4 flex items-start gap-4">
                  <input
                    type="checkbox"
                    checked={selectedLeads.has(lead.address)}
                    onChange={() => toggleLeadSelection(lead.address)}
                    className="mt-1 w-4 h-4 text-purple-600 rounded focus:ring-purple-500"
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          {getPriorityBadge(lead.protectionLeadScore || lead.motivationScore)}
                          {getRentalBadge(lead.rentalConfidenceLabel, lead.rentalConfidence)}
                          {getLeakRiskBadge(lead.leakRiskLabel, lead.leakRiskScore)}
                          {getTaxFlagBadge(lead.taxOverAssessmentFlag, lead.taxAnnualSavingsLow)}
                          {lead.assumability?.assumable === 'likely' && (
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                              lead.assumability.attractiveness === 'very_attractive' 
                                ? 'bg-orange-100 text-orange-700 animate-pulse' 
                                : lead.assumability.attractiveness === 'attractive'
                                ? 'bg-yellow-100 text-yellow-700'
                                : 'bg-green-100 text-green-700'
                            }`}>
                              ✅ {lead.assumability.loanType} Assumable
                              {(lead.assumability.rateSavings ?? 0) > 0 && ` (${lead.assumability.rateSavings?.toFixed(1)}% ↓)`}
                            </span>
                          )}
                          {lead.assumability?.assumable === 'possible' && (
                            <span className="px-2 py-1 text-xs font-medium rounded-full bg-yellow-100 text-yellow-700">
                              ⚠️ {lead.assumability.loanType} - May Be Assumable
                            </span>
                          )}
                          {lead.mortgage && !lead.assumability && (
                            <span className="px-2 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-700">
                              📋 {lead.mortgage.loanType || 'Mortgage'} ${(lead.mortgage.amount / 1000).toFixed(0)}K
                            </span>
                          )}
                          {lead.mortgage?.interestRate && (lead.assumability?.rateSavings ?? 0) > 0 && (
                            <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-100 text-green-700">
                              💰 {lead.mortgage.interestRate}% rate
                            </span>
                          )}
                          {lead.owner.isCorporate && (
                            <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs font-medium rounded-full">
                              Corporate
                            </span>
                          )}
                          {lead.ownerPortfolioBand === '2-15' && (
                            <span className="px-2 py-1 bg-emerald-100 text-emerald-700 text-xs font-medium rounded-full">
                              {lead.ownerPortfolioCount}-prop portfolio
                            </span>
                          )}
                          {lead.ownerPortfolioBand === '16+' && (
                            <span className="px-2 py-1 bg-slate-100 text-slate-600 text-xs font-medium rounded-full">
                              {lead.ownerPortfolioCount}-prop pro
                            </span>
                          )}
                          {Number.isFinite(lead.ownerDistanceMiles) && lead.ownerDistanceMiles >= 50 && (
                            <span className="px-2 py-1 bg-indigo-100 text-indigo-700 text-xs font-medium rounded-full">
                              {lead.ownerDistanceMiles} mi away
                            </span>
                          )}
                          {lead.listedInLast90Days && !lead.listedForRent && (
                            <span className="px-2 py-1 bg-amber-100 text-amber-800 text-xs font-medium rounded-full">
                              Listed ≤90d
                            </span>
                          )}
                          {lead.listedInLast5Years && !lead.listedInLast90Days && !lead.listedForRent && (
                            <span className="px-2 py-1 bg-teal-50 text-teal-700 text-xs font-medium rounded-full">
                              Rental history
                            </span>
                          )}
                          {lead.likelyFreeAndClear && (
                            <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                              Free & Clear
                            </span>
                          )}
                          {lead.isOutOfState && (
                            <span className="px-2 py-1 bg-indigo-100 text-indigo-700 text-xs font-medium rounded-full">
                              Out-of-State
                            </span>
                          )}
                        </div>
                        <h3 className="font-semibold text-gray-900">{lead.address}</h3>
                        <p className="text-sm text-gray-500">
                          {lead.city}, {lead.state} {lead.zipCode}
                        </p>
                      </div>

                      <div className="text-right">
                        <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-full ${getMotivationColor(lead.protectionLeadScore || lead.motivationScore)}`}>
                          <TrendingUp className="h-4 w-4" />
                          <span className="font-bold">{lead.protectionLeadScore || lead.motivationScore}</span>
                        </div>
                        <div className="text-xs text-gray-500 mt-1">
                          {lead.protectionLeadScore ? 'Protection Score' : 'Motivation Score'}
                        </div>
                        {lead.rentEstimate ? (
                          <div className="text-xs text-emerald-700 mt-1">
                            Rent ~${lead.rentEstimate.toLocaleString()}/mo
                            {lead.grossYield ? ` · ${lead.grossYield}% yield` : ''}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    {/* Property Details Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mt-4">
                      <div>
                        <div className="text-xs text-gray-500">Type</div>
                        <div className="font-medium text-gray-900">{lead.propertyType}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Beds/Baths</div>
                        <div className="font-medium text-gray-900">{lead.beds}bd / {lead.baths}ba</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Sqft</div>
                        <div className="font-medium text-gray-900">{lead.sqft?.toLocaleString() || 'N/A'}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Year Built</div>
                        <div className="font-medium text-gray-900">{lead.yearBuilt || 'N/A'}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Assessed Value</div>
                        <div className="font-medium text-gray-900">${lead.assessedValue?.toLocaleString() || 'N/A'}</div>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500">Years Owned</div>
                        <div className="font-medium text-gray-900">{lead.ownershipYears} years</div>
                      </div>
                    </div>

                    {lead.insuranceEstimate && (
                      <div className="mt-4">
                        <InsurancePremiumEstimatorCard
                          estimate={lead.insuranceEstimate}
                          compact
                        />
                      </div>
                    )}

                    {/* Expandable Details */}
                    <button
                      onClick={() => setExpandedLead(expandedLead === lead.address ? null : lead.address)}
                      className="mt-4 text-sm text-purple-600 hover:text-purple-700 flex items-center gap-1"
                    >
                      {expandedLead === lead.address ? (
                        <>
                          <ChevronUp className="h-4 w-4" />
                          Hide Details
                        </>
                      ) : (
                        <>
                          <ChevronDown className="h-4 w-4" />
                          Show Owner & Motivation Details
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {/* Expanded Details */}
                {expandedLead === lead.address && (
                  <div className="px-4 pb-4 pt-0 ml-8 border-t border-gray-100">
                    <div className="grid md:grid-cols-2 gap-6 pt-4">
                      {/* Owner Info */}
                      <div>
                        <h4 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                          <Users className="h-4 w-4" />
                          Owner Information
                        </h4>
                        <div className="space-y-2 text-sm">
                          <div className="flex items-start gap-2">
                            <span className="text-gray-500 w-24 flex-shrink-0">Name:</span>
                            <span className="font-medium text-gray-900">
                              {lead.owner.name}
                              {lead.owner.name2 && <span className="text-gray-500"> & {lead.owner.name2}</span>}
                            </span>
                          </div>
                          <div className="flex items-start gap-2">
                            <span className="text-gray-500 w-24 flex-shrink-0">Mailing:</span>
                            <span className="text-gray-900">{lead.owner.mailingAddress || 'Not available'}</span>
                          </div>
                          {Number.isFinite(lead.ownerDistanceMiles) && (
                            <div className="flex items-start gap-2">
                              <span className="text-gray-500 w-24 flex-shrink-0">Distance:</span>
                              <span className="text-gray-900">
                                ~{lead.ownerDistanceMiles} miles from property
                                {lead.ownerDistanceBand === 'remote_50plus' || lead.ownerDistanceBand === 'out_of_state_far'
                                  ? ' (remote landlord)'
                                  : ''}
                              </span>
                            </div>
                          )}
                          {lead.ownerPortfolioCount != null && (
                            <div className="flex items-start gap-2">
                              <span className="text-gray-500 w-24 flex-shrink-0">Portfolio:</span>
                              <span className="text-gray-900">
                                {lead.ownerPortfolioCount} propert{lead.ownerPortfolioCount === 1 ? 'y' : 'ies'} in this search
                                {lead.ownerPortfolioBand === '2-15' ? ' (mom-and-pop band)' : ''}
                                {lead.ownerPortfolioBand === '16+' ? ' (professional — deprioritize)' : ''}
                              </span>
                            </div>
                          )}
                          {lead.owner.isCorporate && (
                            <div className="flex items-center gap-2 text-blue-600">
                              <Building2 className="h-4 w-4" />
                              Corporate/LLC Owner
                            </div>
                          )}
                        </div>

                        {/* Quick Actions */}
                        <div className="mt-4 flex flex-wrap gap-2">
                          <button 
                            onClick={() => handleOpenOutreach(lead, searchMode)}
                            className="px-3 py-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-white text-sm font-medium rounded-lg hover:from-purple-700 hover:to-indigo-700 flex items-center gap-1 shadow-sm"
                          >
                            <Sparkles className="h-4 w-4" />
                            {searchMode === 'iot_protection' ? 'AI Protection Outreach' : 'AI Outreach'}
                          </button>
                          <button className="px-3 py-1.5 bg-purple-100 text-purple-700 text-sm font-medium rounded-lg hover:bg-purple-200 flex items-center gap-1">
                            <Mail className="h-4 w-4" />
                            Draft Letter
                          </button>
                          <a
                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.address)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 flex items-center gap-1"
                          >
                            <MapIcon className="h-4 w-4" />
                            View Map
                          </a>
                          <a
                            href={`https://www.zillow.com/homes/${encodeURIComponent(lead.address)}_rb/`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200 flex items-center gap-1"
                          >
                            <ExternalLink className="h-4 w-4" />
                            Zillow
                          </a>
                        </div>
                      </div>

                      {/* Motivation Factors */}
                      <div>
                        <h4 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                          <TrendingUp className="h-4 w-4" />
                          Motivation Factors
                        </h4>
                        <ul className="space-y-2">
                          {(lead.motivationFactors || []).map((factor, idx) => (
                            <li key={idx} className="flex items-start gap-2 text-sm">
                              <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
                              <span className="text-gray-700">{factor}</span>
                            </li>
                          ))}
                        </ul>

                        {lead.rentalSignals?.length ? (
                          <div className="mt-4">
                            <h5 className="text-sm font-semibold text-gray-800 mb-2">Rental Signals</h5>
                            <ul className="space-y-1">
                              {lead.rentalSignals.map((signal, idx) => (
                                <li key={idx} className="text-sm text-gray-700">• {signal}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {lead.leakRiskSignals?.length ? (
                          <div className="mt-4">
                            <h5 className="text-sm font-semibold text-gray-800 mb-2">Leak Risk Signals</h5>
                            <ul className="space-y-1">
                              {lead.leakRiskSignals.map((signal, idx) => (
                                <li key={idx} className="text-sm text-gray-700">• {signal}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {(lead.taxOverAssessmentFlag === 'strong' || lead.taxOverAssessmentFlag === 'moderate') && (
                          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                            <h5 className="text-sm font-semibold text-amber-900 mb-1">
                              Tax assessment — flagged for review
                            </h5>
                            <p className="text-sm text-amber-900/90 mb-2">
                              {lead.taxOverAssessmentNarrative
                                || `Equity excess ~${lead.taxEquityExcessPct}% vs nearby comps.`}
                            </p>
                            <div className="text-xs text-amber-800 space-y-1">
                              {Number.isFinite(Number(lead.taxAnnualSavingsLow)) && Number(lead.taxAnnualSavingsLow) > 0 && (
                                <div>
                                  Est. annual impact (low end): ~${Math.round(Number(lead.taxAnnualSavingsLow)).toLocaleString()}
                                  {Number(lead.taxAnnualSavingsHigh) > Number(lead.taxAnnualSavingsLow)
                                    ? `–$${Math.round(Number(lead.taxAnnualSavingsHigh)).toLocaleString()}`
                                    : ''}
                                </div>
                              )}
                              {lead.taxAppealDeadline && (
                                <div>Appeal window: {lead.taxAppealDeadline}</div>
                              )}
                              <div className="italic text-amber-700/80">
                                Estimate for owner review — not legal or tax advice.
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Estimated Equity */}
                        {lead.estimatedEquityPercent !== undefined && (
                          <div className="mt-4 p-3 bg-green-50 rounded-lg">
                            <div className="text-sm text-green-800">
                              <strong>Estimated Equity:</strong> ~{lead.estimatedEquityPercent}%
                            </div>
                            {lead.likelyFreeAndClear && (
                              <div className="text-xs text-green-600 mt-1">
                                Likely owns property free and clear
                              </div>
                            )}
                          </div>
                        )}

                        {lead.insuranceEstimate && (
                          <div className="mt-4">
                            <InsurancePremiumEstimatorCard estimate={lead.insuranceEstimate} />
                          </div>
                        )}

                        {/* Mortgage Assumability */}
                        {(lead.mortgage || lead.assumability) && (
                          <div className={`mt-4 p-3 rounded-lg ${
                            lead.assumability?.assumable === 'likely' && lead.assumability?.attractiveness === 'very_attractive'
                              ? 'bg-orange-50 border border-orange-200'
                              : lead.assumability?.assumable === 'likely'
                              ? 'bg-green-50 border border-green-200'
                              : lead.assumability?.assumable === 'possible'
                              ? 'bg-yellow-50 border border-yellow-200'
                              : lead.assumability?.assumable === 'unlikely'
                              ? 'bg-gray-50 border border-gray-200'
                              : 'bg-blue-50 border border-blue-200'
                          }`}>
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-lg">🏦</span>
                              <strong className={`${
                                lead.assumability?.assumable === 'likely' ? 'text-green-800' : 
                                lead.assumability?.assumable === 'possible' ? 'text-yellow-800' :
                                lead.assumability?.assumable === 'unlikely' ? 'text-gray-700' : 'text-blue-700'
                              }`}>
                                {lead.assumability?.assumable === 'likely' ? '✅ ASSUMABLE MORTGAGE' : 
                                 lead.assumability?.assumable === 'possible' ? '⚠️ POSSIBLY ASSUMABLE' :
                                 lead.assumability?.assumable === 'unlikely' ? '❌ Non-Assumable' : 
                                 lead.mortgage ? '📋 Mortgage Info' : 'Unknown'}
                              </strong>
                            </div>
                            
                            {/* Mortgage Details */}
                            {lead.mortgage && (
                              <div className="text-sm space-y-1 mb-2 pb-2 border-b border-gray-200">
                                <div className="flex justify-between">
                                  <span className="text-gray-600">Loan Amount:</span>
                                  <span className="font-medium">${lead.mortgage.amount?.toLocaleString()}</span>
                                </div>
                                {lead.assumability?.remainingBalance !== undefined && lead.assumability?.remainingBalance !== null && (
                                  <div className="flex justify-between text-purple-700 font-medium">
                                    <span>💰 Est. Balance Remaining:</span>
                                    <span className="font-bold">${Math.round(lead.assumability.remainingBalance).toLocaleString()}</span>
                                  </div>
                                )}
                                {lead.mortgage.loanType && (
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">Loan Type:</span>
                                    <span className="font-medium">
                                      {lead.mortgage.loanType === 'CNV' ? 'Conventional' :
                                       lead.mortgage.loanType === 'ARM' ? 'Adjustable Rate (ARM)' :
                                       lead.mortgage.loanType === 'SCB' ? 'Seller Carryback' :
                                       lead.mortgage.loanType === 'PMM' ? 'Purchase Money' :
                                       lead.mortgage.loanType}
                                    </span>
                                  </div>
                                )}
                                {lead.mortgage.interestRate && (
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">Interest Rate{lead.mortgage.rateEstimated ? ' (est.)' : ''}:</span>
                                    <span className={`font-medium ${lead.mortgage.rateEstimated ? 'text-gray-500 italic' : ''}`}>
                                      {lead.mortgage.interestRate}%
                                      {lead.mortgage.rateEstimated && <span className="text-xs ml-1">(from FRED)</span>}
                                    </span>
                                  </div>
                                )}
                                {lead.mortgage.date && (
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">Loan Date:</span>
                                    <span className="font-medium">{new Date(lead.mortgage.date).toLocaleDateString()}</span>
                                  </div>
                                )}
                                {lead.mortgage.lender && (
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">Lender:</span>
                                    <span className="font-medium text-right max-w-[180px] truncate">
                                      {typeof lead.mortgage.lender === 'string' 
                                        ? lead.mortgage.lender 
                                        : lead.mortgage.lender.lastname || 'Unknown'}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                            
                            {/* Assumability Analysis */}
                            {lead.assumability && (
                              <div className="text-sm space-y-1">
                                {(lead.assumability.rateSavings ?? 0) > 0 && (
                                  <div className="flex justify-between text-green-700 font-medium">
                                    <span>💰 Rate Savings vs Today:</span>
                                    <span className="font-bold">{lead.assumability.rateSavings?.toFixed(2)}% lower!</span>
                                  </div>
                                )}
                                {lead.assumability.remainingBalance && (
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">Est. Balance:</span>
                                    <span className="font-medium">${Math.round(lead.assumability.remainingBalance).toLocaleString()}</span>
                                  </div>
                                )}
                                {lead.assumability.percentPaid && lead.assumability.percentPaid > 0 && (
                                  <div className="flex justify-between">
                                    <span className="text-gray-600">Paid Off:</span>
                                    <span className="font-medium">{lead.assumability.percentPaid.toFixed(1)}%</span>
                                  </div>
                                )}
                                <div className="mt-2 text-xs text-gray-500 italic">
                                  {lead.assumability.reason}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!loading && leads.length === 0 && searchStats === null && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
            <div className="w-16 h-16 bg-purple-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Search className="h-8 w-8 text-purple-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-800 mb-2">Search for Absentee Owners</h3>
            <p className="text-gray-500 max-w-md mx-auto">
              Enter a ZIP code and search criteria above to find off-market properties with
              absentee owners who may be motivated to sell at a discount.
            </p>
          </div>
        )}

        {/* No Results */}
        {!loading && leads.length === 0 && searchStats !== null && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
            <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-yellow-600" />
            </div>
            <h3 className="text-lg font-semibold text-gray-800 mb-2">No Matching Properties Found</h3>
            <p className="text-gray-500 max-w-md mx-auto">
              Try adjusting your filters or searching a different area.
              {searchStats.totalFound > 0 && (
                <span className="block mt-2">
                  Found {searchStats.totalFound} absentee properties, but none matched your additional filters.
                </span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* AI Outreach Modal */}
      <AbsenteeOutreachModal
        isOpen={outreachModalOpen}
        onClose={() => {
          setOutreachModalOpen(false);
          setSelectedLeadForOutreach(null);
        }}
        lead={selectedLeadForOutreach}
        purpose={outreachPurpose}
        onEmailSent={handleEmailSent}
      />
    </div>
  );
}
