import React, { useState, useEffect, useCallback } from 'react';

interface Market {
  city: string;
  state: string;
  zip: string;
  listingCount?: number;
  activeCount?: number;
}

interface MLSProperty {
  LISTINGKEY: string;
  LISTINGID: string;
  LISTPRICE: number;
  STREETNUMBER: string;
  STREETNAME: string;
  STREETSUFFIX: string;
  UNITNUMBER: string;
  CITY: string;
  STATEORPROVINCE: string;
  POSTALCODE: string;
  COUNTYORPARISH: string;
  NEIGHBORHOOD: string;
  SUBDIVISIONNAME: string;
  BEDROOMSTOTAL: number;
  BATHROOMSTOTALINTEGER: number;
  BATHROOMSFULL: number;
  BATHROOMSHALF: number;
  LIVINGAREA: number;
  LIVINGAREAUNITS: string;
  LOTSIZEAREA: number;
  LOTSIZEUNITS: string;
  LOTSIZEDIMENSIONS: string;
  YEARBUILT: number;
  STORIES: number;
  STORIESTOTAL: number;
  GARAGESPACES: number;
  GARAGEYN: boolean;
  PARKINGTOTAL: number;
  PROPERTYTYPE: string;
  PROPERTYSUBTYPE: string;
  STANDARDSTATUS: string;
  ARCHITECTURALSTYLE: string;
  STRUCTURETYPE: string;
  CONSTRUCTIONMATERIALS: string;
  ROOF: string;
  FOUNDATIONDETAILS: string;
  LEVELS: string;
  NEWCONSTRUCTIONYN: boolean;
  PROPERTYCONDITION: string;
  LATITUDE: number;
  LONGITUDE: number;
  PUBLICREMARKS: string;
  PHOTOSCOUNT: number;
  DAYSONMARKET: number;
  MODIFICATIONTIMESTAMP: string;
  CLOSEPRICE: number;
  CLOSEDATE: string;
  ORIGINALLISTPRICE: number;
  CAPRATE: number;
  NETOPERATINGINCOME: number;
  GROSSINCOME: number;
  TOTALEXPENSES: number;
  TOTALACTUALRENT: number;
  TOTALMONTHLYRENT: number;
  OPERATINGEXPENSE: number;
  GROSSMULTIPLIER: number;
  VACANCYALLOWANCERATE: number;
  TAXANNUALAMOUNT: number;
  TAXASSESSEDVALUE: number;
  TAXYEAR: number;
  ZONING: string;
  ZONINGDESCRIPTION: string;
  ASSOCIATIONYN: boolean;
  ASSOCIATIONFEE: number;
  ASSOCIATIONFEEFREQUENCY: string;
  ASSOCIATIONNAME: string;
  ELEMENTARYSCHOOL: string;
  MIDDLEORJUNIORSCHOOL: string;
  HIGHSCHOOL: string;
  ELEMENTARYSCHOOLDISTRICT: string;
  HIGHSCHOOLDISTRICT: string;
  POOLYN: boolean;
  FIREPLACEYN: boolean;
  FIREPLACESTOTAL: number;
  WATERFRONTYN: boolean;
  WALKSCORE: number;
  RENTMIN: number;
  RENTMAX: number;
  LEASETERM: string;
  PETSALLOWED: string;
  DEPOSITSECURITY: number;
  AVAILABILITYDATE: string;
  LISTAGENTFULLNAME: string;
  LISTOFFICENAME: string;
  VIRTUALTOURURLUNBRANDED: string;
  PARCELNUMBER?: string;
  IMPROVEMENTSAMOUNT?: number;
  IMPROVEMENTSDESCRIPTION?: string;
  YEARBUILTEFFECTIVE?: number;
  PRICEPERSQUAREFOOT?: number;
  CUMULATIVEDAYSONMARKET?: number;
  ONMARKETDATE?: string;
  primaryImage?: string;
  images?: Array<{ url: string; isPrimary: boolean; order: number; description: string; }>;
  rooms?: any[];
  openHouses?: any[];
  unitTypes?: any[];
  priceHistory?: any[];
}

interface HistoricalListing {
  LISTINGKEY: string;
  LISTINGID: string;
  STREETNUMBER: string;
  STREETNAME: string;
  STREETSUFFIX: string;
  CITY: string;
  STATEORPROVINCE: string;
  POSTALCODE: string;
  PARCELNUMBER: string;
  LISTPRICE: number;
  CLOSEPRICE: number;
  ORIGINALLISTPRICE: number;
  STANDARDSTATUS: string;
  PROPERTYTYPE: string;
  ONMARKETDATE: string;
  CLOSEDATE: string;
  DAYSONMARKET: number;
  BEDROOMSTOTAL: number;
  BATHROOMSTOTALINTEGER: number;
  LIVINGAREA: number;
  YEARBUILT: number;
  YEARBUILTEFFECTIVE: number;
  PROPERTYCONDITION: string;
  IMPROVEMENTSAMOUNT: number;
  IMPROVEMENTSDESCRIPTION: string;
  PRICEPERSQUAREFOOT: number;
  LISTAGENTFULLNAME: string;
  LISTOFFICENAME: string;
  primaryImage?: string;
}

interface AddressTimelineEntry {
  LISTINGKEY: string;
  LISTINGID: string;
  PRICE: number;
  STATUS: string;
  EFFECTIVETIMESTAMP: string;
  ONMARKETDATE: string;
  CLOSEDATE: string;
  LISTPRICE: number;
  CLOSEPRICE: number;
}

interface MarketAppreciationEntry {
  CLOSE_YEAR: number;
  SALES_COUNT: number;
  AVG_CLOSE_PRICE: number;
  MEDIAN_CLOSE_PRICE: number;
  AVG_PRICE_PER_SQFT: number;
  AVG_DAYS_ON_MARKET: number;
  AVG_SALE_TO_LIST_PCT: number;
}

interface HistoricalImage {
  MEDIAURL: string;
  IMAGEOF: string;
  PREFERREDPHOTOYN: boolean;
  SHORTDESCRIPTION: string;
  MEDIAMODIFICATIONTIMESTAMP: string;
  order: number;
}

interface MLSDataExplorerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PROPERTY_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'Residential', label: '🏠 Residential' },
  { value: 'Residential Lease', label: '🏘️ Residential Lease' },
  { value: 'Land', label: '🌿 Land' },
  { value: 'Commercial Sale', label: '🏢 Commercial Sale' },
  { value: 'Commercial Lease', label: '🏬 Commercial Lease' },
];

const MLSDataExplorerModal: React.FC<MLSDataExplorerModalProps> = ({ isOpen, onClose }) => {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<Market | null>(null);
  const [zipCode, setZipCode] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [properties, setProperties] = useState<MLSProperty[]>([]);
  const [selectedProperty, setSelectedProperty] = useState<MLSProperty | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [propertyTypeFilter, setPropertyTypeFilter] = useState<string>('');
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [detailTab, setDetailTab] = useState<'overview' | 'financial' | 'features' | 'schools' | 'history'>('overview');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minBeds, setMinBeds] = useState('');
  const [minBaths, setMinBaths] = useState('');
  const [minSqft, setMinSqft] = useState('');
  const [maxSqft, setMaxSqft] = useState('');
  const [minYearBuilt, setMinYearBuilt] = useState('');
  const [availableStates, setAvailableStates] = useState<Array<{state: string; count: number}>>([]);

  // Historical listing data
  const [addressHistory, setAddressHistory] = useState<HistoricalListing[]>([]);
  const [addressTimeline, setAddressTimeline] = useState<AddressTimelineEntry[]>([]);
  const [marketAppreciation, setMarketAppreciation] = useState<MarketAppreciationEntry[]>([]);
  const [historicalImages, setHistoricalImages] = useState<Record<string, HistoricalImage[]>>({});
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedHistoricalListing, setSelectedHistoricalListing] = useState<string | null>(null);
  const [historySearchMode, setHistorySearchMode] = useState(false);
  const [historySearchResults, setHistorySearchResults] = useState<any[]>([]);
  const [historySearchLoading, setHistorySearchLoading] = useState(false);
  const [historyDateAfter, setHistoryDateAfter] = useState('');
  const [historyDateBefore, setHistoryDateBefore] = useState('');
  const [historyMultiOnly, setHistoryMultiOnly] = useState(true);
  const [historyRelistOnly, setHistoryRelistOnly] = useState(true);
  const [historyMinGapDays, setHistoryMinGapDays] = useState('180');

  useEffect(() => {
    if (isOpen) {
      fetchMarkets();
      fetchStates();
    }
  }, [isOpen]);

  const fetchMarkets = async () => {
    try {
      const res = await fetch('/api/mls/markets');
      const data = await res.json();
      if (data.ok) setMarkets(data.markets);
    } catch (err) {
      console.error('Failed to fetch markets:', err);
    }
  };

  const fetchStates = async () => {
    try {
      const res = await fetch('/api/mls/states');
      const data = await res.json();
      if (data.ok) setAvailableStates(data.states);
    } catch (err) {
      console.error('Failed to fetch states:', err);
    }
  };

  const searchProperties = async () => {
    setLoading(true);
    setError(null);
    setSelectedProperty(null);
    try {
      const params = new URLSearchParams();
      if (selectedMarket) {
        params.set('city', selectedMarket.city);
        params.set('state', selectedMarket.state);
      }
      if (zipCode) params.set('zip', zipCode);
      if (stateFilter) params.set('state', stateFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (propertyTypeFilter) params.set('propertyType', propertyTypeFilter);
      if (minPrice) params.set('minPrice', minPrice);
      if (maxPrice) params.set('maxPrice', maxPrice);
      if (minBeds) params.set('minBeds', minBeds);
      if (minBaths) params.set('minBaths', minBaths);
      if (minSqft) params.set('minSqft', minSqft);
      if (maxSqft) params.set('maxSqft', maxSqft);
      if (minYearBuilt) params.set('minYearBuilt', minYearBuilt);
      params.set('limit', '50');
      const res = await fetch(`/api/mls/search?${params.toString()}`);
      const data = await res.json();
      if (data.ok) {
        setProperties(data.properties);
      } else {
        setError(data.error || 'Failed to fetch properties');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to search properties');
    } finally {
      setLoading(false);
    }
  };

  const fetchPropertyDetails = async (listingKey: string) => {
    setLoading(true);
    setDetailTab('overview');
    setAddressHistory([]);
    setAddressTimeline([]);
    setMarketAppreciation([]);
    setHistoricalImages({});
    setHistoryError(null);
    setSelectedHistoricalListing(null);
    try {
      const res = await fetch(`/api/mls/property/${encodeURIComponent(listingKey)}/full`);
      const data = await res.json();
      if (data.ok) setSelectedProperty(data.property);
    } catch (err) {
      console.error('Failed to fetch property:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch all historical listings at the same address
  const fetchAddressHistory = useCallback(async (property: MLSProperty) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const params = new URLSearchParams();
      if (property.STREETNUMBER) params.set('streetNumber', property.STREETNUMBER);
      if (property.STREETNAME) params.set('streetName', property.STREETNAME);
      if (property.CITY) params.set('city', property.CITY);
      if (property.STATEORPROVINCE) params.set('state', property.STATEORPROVINCE);
      if (property.POSTALCODE) params.set('postalCode', property.POSTALCODE);
      if (property.PARCELNUMBER) params.set('parcelnumber', property.PARCELNUMBER);

      // Fetch address history, address timeline, and market appreciation in parallel
      const [historyRes, timelineRes, appreciationRes] = await Promise.all([
        fetch(`/api/mls/history/address?${params.toString()}`),
        fetch(`/api/mls/history/address-timeline?${params.toString()}`),
        fetch(`/api/mls/history/market-appreciation?city=${encodeURIComponent(property.CITY || '')}&state=${encodeURIComponent(property.STATEORPROVINCE || '')}&zip=${encodeURIComponent(property.POSTALCODE || '')}`)
      ]);

      const [historyData, timelineData, appreciationData] = await Promise.all([
        historyRes.json(),
        timelineRes.json(),
        appreciationRes.json()
      ]);

      if (historyData.ok) {
        setAddressHistory(historyData.listings);
        // Fetch images for all listings at this address
        const listingKeys = historyData.listings.map((l: HistoricalListing) => l.LISTINGKEY);
        if (listingKeys.length > 0) {
          try {
            const imgRes = await fetch(`/api/mls/history/images?listingKeys=${listingKeys.join(',')}`);
            const imgData = await imgRes.json();
            if (imgData.ok) setHistoricalImages(imgData.images);
          } catch (e) {
            console.error('Failed to fetch historical images:', e);
          }
        }
      }
      if (timelineData.ok) setAddressTimeline(timelineData.timeline);
      if (appreciationData.ok) setMarketAppreciation(appreciationData.stats);
    } catch (err: any) {
      setHistoryError(err.message || 'Failed to fetch historical data');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Search for properties with multiple historical listings (renovation candidates)
  const searchHistorical = async () => {
    setHistorySearchLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedMarket) {
        params.set('city', selectedMarket.city);
        params.set('state', selectedMarket.state);
      }
      if (zipCode) params.set('zip', zipCode);
      if (stateFilter) params.set('state', stateFilter);
      if (propertyTypeFilter) params.set('propertyType', propertyTypeFilter);
      if (minPrice) params.set('minPrice', minPrice);
      if (maxPrice) params.set('maxPrice', maxPrice);
      if (historyDateAfter) params.set('onMarketAfter', historyDateAfter);
      if (historyDateBefore) params.set('onMarketBefore', historyDateBefore);
      if (historyMultiOnly) params.set('multiListingOnly', 'true');
      if (historyRelistOnly) params.set('relistedOnly', 'true');
      if (historyMinGapDays) params.set('minRelistGapDays', historyMinGapDays);
      params.set('limit', '50');

      const res = await fetch(`/api/mls/history/search?${params.toString()}`);
      const raw = await res.text();
      const data = raw ? JSON.parse(raw) : null;
      if (!res.ok) {
        throw new Error(data?.error || 'Historical search failed');
      }
      if (data?.ok) {
        setHistorySearchResults(data.properties || []);
        setProperties(data.properties || []); // Also show in main list
      }
    } catch (err) {
      console.error('Historical search error:', err);
    } finally {
      setHistorySearchLoading(false);
    }
  };

  // When history tab is selected and we have a property, fetch history
  useEffect(() => {
    if (detailTab === 'history' && selectedProperty && addressHistory.length === 0 && !historyLoading) {
      fetchAddressHistory(selectedProperty);
    }
  }, [detailTab, selectedProperty, addressHistory.length, historyLoading, fetchAddressHistory]);

  const getStatusColor = (status: string) => {
    switch (status?.toLowerCase()) {
      case 'active': return 'bg-green-100 text-green-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      case 'active under contract': return 'bg-yellow-100 text-yellow-800';
      case 'coming soon': return 'bg-blue-100 text-blue-800';
      case 'closed': return 'bg-gray-100 text-gray-800';
      case 'canceled': return 'bg-red-100 text-red-800';
      case 'expired': return 'bg-orange-100 text-orange-800';
      case 'withdrawn': return 'bg-red-100 text-red-800';
      case 'hold': return 'bg-purple-100 text-purple-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getPropertyTypeIcon = (type: string) => {
    switch (type) {
      case 'Residential': return '🏠';
      case 'Residential Lease': return '🏘️';
      case 'Land': return '🌿';
      case 'Commercial Sale': return '🏢';
      case 'Commercial Lease': return '🏬';
      default: return '🏠';
    }
  };

  const fmt = (val: number | null | undefined) => {
    if (val == null) return 'N/A';
    return '$' + val.toLocaleString();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-50 overflow-hidden">
      <div className="h-full flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-purple-600 to-pink-600">
            <div>
              <h2 className="text-2xl font-bold text-white">🔍 MLS Data Explorer</h2>
              <p className="text-purple-100 text-sm mt-1">Search real MLS listings • Residential, Commercial, Land & Rentals</p>
            </div>
            <button onClick={onClose} className="text-white hover:bg-white/20 rounded-full p-2 transition">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Search Controls */}
          <div className="p-4 border-b bg-gray-50">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-700 mb-1">State</label>
                <select className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm focus:ring-2 focus:ring-purple-500"
                  value={stateFilter} onChange={e => { setStateFilter(e.target.value); setSelectedMarket(null); }}>
                  <option value="">All</option>
                  {availableStates.map(s => (
                    <option key={s.state} value={s.state}>{s.state} ({s.count})</option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs font-medium text-gray-700 mb-1">City / Market</label>
                <select className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm focus:ring-2 focus:ring-purple-500"
                  value={selectedMarket ? `${selectedMarket.city}-${selectedMarket.state}` : ''}
                  onChange={e => {
                    if (e.target.value) {
                      const [city, state] = e.target.value.split('-');
                      setSelectedMarket(markets.find(m => m.city === city && m.state === state) || null);
                      setZipCode(''); setStateFilter('');
                    } else { setSelectedMarket(null); }
                  }}>
                  <option value="">-- Select City --</option>
                  {markets.filter(m => !stateFilter || m.state === stateFilter).map(m => (
                    <option key={`${m.city}-${m.state}`} value={`${m.city}-${m.state}`}>
                      {m.city}, {m.state} {m.listingCount ? `(${m.listingCount})` : `(${m.zip})`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-28">
                <label className="block text-xs font-medium text-gray-700 mb-1">ZIP Code</label>
                <input type="text" className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm focus:ring-2 focus:ring-purple-500"
                  placeholder="e.g. 97201" value={zipCode}
                  onChange={e => { setZipCode(e.target.value); if (e.target.value) setSelectedMarket(null); }} />
              </div>
              <div className="w-40">
                <label className="block text-xs font-medium text-gray-700 mb-1">Property Type</label>
                <select className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm focus:ring-2 focus:ring-purple-500"
                  value={propertyTypeFilter} onChange={e => setPropertyTypeFilter(e.target.value)}>
                  {PROPERTY_TYPES.map(pt => <option key={pt.value} value={pt.value}>{pt.label}</option>)}
                </select>
              </div>
              <div className="w-36">
                <label className="block text-xs font-medium text-gray-700 mb-1">Status</label>
                <select className="w-full rounded-lg border border-gray-300 px-2 py-2 text-sm focus:ring-2 focus:ring-purple-500"
                  value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                  <option value="">All Statuses</option>
                  <option value="Active">Active</option>
                  <option value="Active Under Contract">Under Contract</option>
                  <option value="Pending">Pending</option>
                  <option value="Coming Soon">Coming Soon</option>
                  <option value="Closed">Closed</option>
                  <option value="Canceled">Canceled</option>
                  <option value="Expired">Expired</option>
                  <option value="Withdrawn">Withdrawn</option>
                </select>
              </div>
              <button onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
                className="px-3 py-2 text-sm text-purple-600 hover:bg-purple-50 rounded-lg transition flex items-center gap-1">
                <svg className={`w-4 h-4 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                Filters
              </button>
              <button onClick={() => setHistorySearchMode(!historySearchMode)}
                className={`px-3 py-2 text-sm rounded-lg transition flex items-center gap-1 ${
                  historySearchMode ? 'bg-amber-100 text-amber-700 ring-1 ring-amber-300' : 'text-amber-600 hover:bg-amber-50'
                }`}>
                📜 Historical
              </button>
              <button onClick={historySearchMode ? searchHistorical : searchProperties} disabled={loading || historySearchLoading || (!selectedMarket && !zipCode && !stateFilter)}
                className="px-6 py-2 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2 text-sm">
                {loading || historySearchLoading ? (
                  <><svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>Searching...</>
                ) : historySearchMode ? <>📜 Search Historical</> : <>🔍 Search</>}
              </button>
            </div>
            {showAdvancedFilters && (
              <div className="flex flex-wrap gap-3 items-end mt-3 pt-3 border-t border-gray-200">
                <div className="w-28">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Min Price</label>
                  <input type="number" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    placeholder="$0" value={minPrice} onChange={e => setMinPrice(e.target.value)} />
                </div>
                <div className="w-28">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Max Price</label>
                  <input type="number" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    placeholder="No max" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} />
                </div>
                <div className="w-20">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Beds+</label>
                  <select className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    value={minBeds} onChange={e => setMinBeds(e.target.value)}>
                    <option value="">Any</option>
                    {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n}+</option>)}
                  </select>
                </div>
                <div className="w-20">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Baths+</label>
                  <select className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    value={minBaths} onChange={e => setMinBaths(e.target.value)}>
                    <option value="">Any</option>
                    {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}+</option>)}
                  </select>
                </div>
                <div className="w-24">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Min Sqft</label>
                  <input type="number" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    placeholder="0" value={minSqft} onChange={e => setMinSqft(e.target.value)} />
                </div>
                <div className="w-24">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Max Sqft</label>
                  <input type="number" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    placeholder="No max" value={maxSqft} onChange={e => setMaxSqft(e.target.value)} />
                </div>
                <div className="w-24">
                  <label className="block text-xs font-medium text-gray-500 mb-1">Built After</label>
                  <input type="number" className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                    placeholder="Year" value={minYearBuilt} onChange={e => setMinYearBuilt(e.target.value)} />
                </div>
                {historySearchMode && (
                  <>
                    <div className="w-full border-t border-amber-200 pt-3 mt-1">
                      <p className="text-xs font-medium text-amber-700 mb-2">📜 Historical Filters</p>
                      <div className="flex flex-wrap gap-3 items-end">
                        <div className="w-36">
                          <label className="block text-xs font-medium text-amber-600 mb-1">On Market After</label>
                          <input type="date" className="w-full rounded-lg border border-amber-300 px-2 py-1.5 text-sm"
                            value={historyDateAfter} onChange={e => setHistoryDateAfter(e.target.value)} />
                        </div>
                        <div className="w-36">
                          <label className="block text-xs font-medium text-amber-600 mb-1">On Market Before</label>
                          <input type="date" className="w-full rounded-lg border border-amber-300 px-2 py-1.5 text-sm"
                            value={historyDateBefore} onChange={e => setHistoryDateBefore(e.target.value)} />
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={historyMultiOnly} onChange={e => setHistoryMultiOnly(e.target.checked)}
                            className="rounded border-amber-300 text-amber-600 focus:ring-amber-500" />
                          <span className="text-xs text-amber-700">Multi-listing only (renovation candidates)</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={historyRelistOnly} onChange={e => setHistoryRelistOnly(e.target.checked)}
                            className="rounded border-amber-300 text-amber-600 focus:ring-amber-500" />
                          <span className="text-xs text-amber-700">Only relisted after a prior close</span>
                        </label>
                        <div className="w-36">
                          <label className="block text-xs font-medium text-amber-600 mb-1">Min Relist Gap (days)</label>
                          <input type="number" min={0} className="w-full rounded-lg border border-amber-300 px-2 py-1.5 text-sm"
                            placeholder="180" value={historyMinGapDays} onChange={e => setHistoryMinGapDays(e.target.value)} />
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
            {error && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
            )}
          </div>

          {/* Main Content */}
          <div className="flex-1 overflow-hidden flex">
            {/* Property List */}
            <div className={`${selectedProperty ? 'w-1/2' : 'w-full'} overflow-y-auto border-r`}>
              {properties.length === 0 && !loading && (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                  </svg>
                  <p className="text-lg">Select a state, city, or enter a ZIP code to search</p>
                  <p className="text-sm mt-1">MultiClass MLS data — Residential, Commercial, Land & Rentals</p>
                  <p className="text-xs mt-3 text-gray-400">{availableStates.length} states • {markets.length} cities available</p>
                </div>
              )}
              <div className="grid gap-4 p-4">
                {properties.map((property) => (
                  <div key={property.LISTINGKEY}
                    className={`bg-white border rounded-xl overflow-hidden hover:shadow-lg transition cursor-pointer ${
                      selectedProperty?.LISTINGKEY === property.LISTINGKEY ? 'ring-2 ring-purple-500' : ''
                    }`}
                    onClick={() => fetchPropertyDetails(property.LISTINGKEY)}>
                    <div className="flex">
                      <div className="w-48 h-36 flex-shrink-0 bg-gray-100">
                        {property.primaryImage ? (
                          <img src={property.primaryImage} alt={property.STREETNAME}
                            className="w-full h-full object-cover"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; (e.target as HTMLImageElement).parentElement!.classList.add('flex','items-center','justify-center'); (e.target as HTMLImageElement).parentElement!.innerHTML = '<svg class="w-12 h-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path></svg>'; }} />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div className="flex-1 p-4">
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="text-xl font-bold text-gray-900">
                              {property.PROPERTYTYPE?.includes('Lease') ? `${fmt(property.LISTPRICE)}/mo` : fmt(property.LISTPRICE)}
                            </p>
                            <p className="text-sm text-gray-600 mt-1">
                              {property.STREETNUMBER} {property.STREETNAME} {property.STREETSUFFIX || ''}
                              {property.UNITNUMBER ? ` #${property.UNITNUMBER}` : ''}
                            </p>
                            <p className="text-sm text-gray-500">{property.CITY}, {property.STATEORPROVINCE} {property.POSTALCODE}</p>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(property.STANDARDSTATUS)}`}>
                              {property.STANDARDSTATUS}
                            </span>
                            <span className="text-xs text-gray-400">{getPropertyTypeIcon(property.PROPERTYTYPE)} {property.PROPERTYTYPE}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-4 mt-3 text-sm text-gray-600">
                          {property.BEDROOMSTOTAL != null && <span><span className="font-semibold">{property.BEDROOMSTOTAL}</span> beds</span>}
                          {property.BATHROOMSTOTALINTEGER != null && <span><span className="font-semibold">{property.BATHROOMSTOTALINTEGER}</span> baths</span>}
                          {property.LIVINGAREA != null && <span><span className="font-semibold">{property.LIVINGAREA?.toLocaleString()}</span> sqft</span>}
                          {property.LOTSIZEAREA != null && !property.LIVINGAREA && (
                            <span><span className="font-semibold">{property.LOTSIZEAREA?.toLocaleString()}</span> {property.LOTSIZEUNITS || 'sqft'} lot</span>
                          )}
                          {property.YEARBUILT != null && <span>Built <span className="font-semibold">{property.YEARBUILT}</span></span>}
                        </div>
                        <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                          {property.PROPERTYSUBTYPE && <span>{property.PROPERTYSUBTYPE}</span>}
                          {property.ARCHITECTURALSTYLE && <span>• {property.ARCHITECTURALSTYLE}</span>}
                          {property.DAYSONMARKET != null && <span>• {property.DAYSONMARKET} DOM</span>}
                          {(property as any).LISTING_COUNT_AT_ADDRESS > 1 && (
                            <span className="text-amber-600 font-medium">• 🔄 {(property as any).LISTING_COUNT_AT_ADDRESS}x listed</span>
                          )}
                          {property.CAPRATE != null && property.CAPRATE > 0 && (
                            <span className="text-green-600 font-medium">• {property.CAPRATE.toFixed(1)}% Cap</span>
                          )}
                          {property.TOTALMONTHLYRENT != null && property.TOTALMONTHLYRENT > 0 && (
                            <span className="text-blue-600 font-medium">• {fmt(property.TOTALMONTHLYRENT)}/mo rent</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Property Details Panel */}
            {selectedProperty && (
              <div className="w-1/2 overflow-y-auto bg-gray-50 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-xl font-bold text-gray-900">Property Details</h3>
                  <button onClick={() => setSelectedProperty(null)} className="text-gray-500 hover:text-gray-700">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* Images Gallery */}
                {selectedProperty.images && selectedProperty.images.length > 0 && (
                  <div className="mb-6">
                    <h4 className="text-sm font-semibold text-gray-700 mb-2">Photos ({selectedProperty.images.length})</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {selectedProperty.images.slice(0, 8).map((img, idx) => (
                        <div key={idx} className="aspect-video bg-gray-200 rounded-lg overflow-hidden">
                          <img src={img.url} alt={img.description || `Photo ${idx + 1}`} className="w-full h-full object-cover"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        </div>
                      ))}
                    </div>
                    {selectedProperty.images.length > 8 && (
                      <p className="text-sm text-gray-500 mt-2 text-center">+{selectedProperty.images.length - 8} more photos</p>
                    )}
                  </div>
                )}

                {/* Price & Address */}
                <div className="bg-white rounded-xl p-4 mb-4 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-3xl font-bold text-gray-900 mb-1">
                        {selectedProperty.PROPERTYTYPE?.includes('Lease') ? `${fmt(selectedProperty.LISTPRICE)}/mo` : fmt(selectedProperty.LISTPRICE)}
                      </p>
                      {selectedProperty.ORIGINALLISTPRICE && selectedProperty.ORIGINALLISTPRICE !== selectedProperty.LISTPRICE && (
                        <p className="text-sm text-gray-400 line-through">Originally {fmt(selectedProperty.ORIGINALLISTPRICE)}</p>
                      )}
                    </div>
                    <span className="text-lg">{getPropertyTypeIcon(selectedProperty.PROPERTYTYPE)}</span>
                  </div>
                  <p className="text-lg text-gray-700 mt-2">
                    {selectedProperty.STREETNUMBER} {selectedProperty.STREETNAME} {selectedProperty.STREETSUFFIX || ''}
                    {selectedProperty.UNITNUMBER ? ` #${selectedProperty.UNITNUMBER}` : ''}
                  </p>
                  <p className="text-gray-600">{selectedProperty.CITY}, {selectedProperty.STATEORPROVINCE} {selectedProperty.POSTALCODE}</p>
                  <p className="text-sm text-gray-500 mt-1">
                    {selectedProperty.COUNTYORPARISH}
                    {selectedProperty.NEIGHBORHOOD ? ` • ${selectedProperty.NEIGHBORHOOD}` : ''}
                    {selectedProperty.SUBDIVISIONNAME ? ` • ${selectedProperty.SUBDIVISIONNAME}` : ''}
                  </p>
                  {selectedProperty.LISTAGENTFULLNAME && (
                    <p className="text-xs text-gray-400 mt-2">Listed by {selectedProperty.LISTAGENTFULLNAME} • {selectedProperty.LISTOFFICENAME}</p>
                  )}
                </div>

                {/* Key Stats */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  {selectedProperty.BEDROOMSTOTAL != null && (
                    <div className="bg-white rounded-xl p-3 shadow-sm text-center">
                      <p className="text-2xl font-bold text-gray-900">{selectedProperty.BEDROOMSTOTAL}</p>
                      <p className="text-xs text-gray-500">Bedrooms</p>
                    </div>
                  )}
                  {selectedProperty.BATHROOMSTOTALINTEGER != null && (
                    <div className="bg-white rounded-xl p-3 shadow-sm text-center">
                      <p className="text-2xl font-bold text-gray-900">{selectedProperty.BATHROOMSTOTALINTEGER}</p>
                      <p className="text-xs text-gray-500">Bathrooms</p>
                    </div>
                  )}
                  {selectedProperty.LIVINGAREA != null && (
                    <div className="bg-white rounded-xl p-3 shadow-sm text-center">
                      <p className="text-2xl font-bold text-gray-900">{selectedProperty.LIVINGAREA?.toLocaleString()}</p>
                      <p className="text-xs text-gray-500">Sq Ft</p>
                    </div>
                  )}
                  <div className="bg-white rounded-xl p-3 shadow-sm text-center">
                    <p className="text-2xl font-bold text-gray-900">{selectedProperty.YEARBUILT || 'N/A'}</p>
                    <p className="text-xs text-gray-500">Year Built</p>
                  </div>
                </div>

                {/* Detail Tabs */}
                <div className="flex border-b mb-4 gap-1">
                  {(['overview', 'financial', 'features', 'schools', 'history'] as const).map(tab => (
                    <button key={tab} onClick={() => setDetailTab(tab)}
                      className={`px-3 py-2 text-sm font-medium rounded-t-lg transition ${
                        detailTab === tab ? 'bg-white text-purple-700 border border-b-white -mb-px' : 'text-gray-500 hover:text-gray-700'
                      }`}>
                      {tab === 'overview' && '📋 Overview'}
                      {tab === 'financial' && '💰 Financial'}
                      {tab === 'features' && '🏗️ Features'}
                      {tab === 'schools' && '🎓 Schools'}
                      {tab === 'history' && '📜 History'}
                    </button>
                  ))}
                </div>

                {/* === OVERVIEW TAB === */}
                {detailTab === 'overview' && (
                  <>
                    <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                      <h4 className="font-semibold text-gray-900 mb-3">Property Information</h4>
                      <div className="grid grid-cols-2 gap-y-2 text-sm">
                        <div className="text-gray-500">Status</div>
                        <div><span className={`px-2 py-0.5 rounded-full text-xs ${getStatusColor(selectedProperty.STANDARDSTATUS)}`}>{selectedProperty.STANDARDSTATUS}</span></div>
                        <div className="text-gray-500">Property Type</div>
                        <div className="font-medium">{selectedProperty.PROPERTYTYPE}</div>
                        {selectedProperty.PROPERTYSUBTYPE && (<><div className="text-gray-500">Subtype</div><div className="font-medium">{selectedProperty.PROPERTYSUBTYPE}</div></>)}
                        {selectedProperty.ARCHITECTURALSTYLE && (<><div className="text-gray-500">Style</div><div className="font-medium">{selectedProperty.ARCHITECTURALSTYLE}</div></>)}
                        {selectedProperty.STRUCTURETYPE && (<><div className="text-gray-500">Structure</div><div className="font-medium">{selectedProperty.STRUCTURETYPE}</div></>)}
                        <div className="text-gray-500">Lot Size</div>
                        <div className="font-medium">{selectedProperty.LOTSIZEAREA?.toLocaleString() || 'N/A'} {selectedProperty.LOTSIZEUNITS}{selectedProperty.LOTSIZEDIMENSIONS ? ` (${selectedProperty.LOTSIZEDIMENSIONS})` : ''}</div>
                        {selectedProperty.STORIES != null && (<><div className="text-gray-500">Stories</div><div className="font-medium">{selectedProperty.STORIES}</div></>)}
                        <div className="text-gray-500">Full / Half Baths</div>
                        <div className="font-medium">{selectedProperty.BATHROOMSFULL || 0} / {selectedProperty.BATHROOMSHALF || 0}</div>
                        {selectedProperty.GARAGESPACES != null && (<><div className="text-gray-500">Garage</div><div className="font-medium">{selectedProperty.GARAGESPACES} spaces</div></>)}
                        {selectedProperty.PARKINGTOTAL != null && (<><div className="text-gray-500">Total Parking</div><div className="font-medium">{selectedProperty.PARKINGTOTAL} spaces</div></>)}
                        <div className="text-gray-500">Days on Market</div>
                        <div className="font-medium">{selectedProperty.DAYSONMARKET ?? 'N/A'}</div>
                        {selectedProperty.NEWCONSTRUCTIONYN && (<><div className="text-gray-500">New Construction</div><div className="font-medium text-green-600">✅ Yes</div></>)}
                        {selectedProperty.PROPERTYCONDITION && (<><div className="text-gray-500">Condition</div><div className="font-medium">{selectedProperty.PROPERTYCONDITION}</div></>)}
                        <div className="text-gray-500">Listing ID</div>
                        <div className="font-medium text-xs">{selectedProperty.LISTINGID}</div>
                      </div>
                    </div>
                    {(selectedProperty.RENTMIN || selectedProperty.RENTMAX || selectedProperty.LEASETERM || selectedProperty.PETSALLOWED) && (
                      <div className="bg-blue-50 rounded-xl p-4 shadow-sm mb-4 border border-blue-100">
                        <h4 className="font-semibold text-blue-900 mb-3">🏘️ Lease / Rental Details</h4>
                        <div className="grid grid-cols-2 gap-y-2 text-sm">
                          {selectedProperty.RENTMIN != null && (<><div className="text-blue-700">Rent Range</div><div className="font-medium">{fmt(selectedProperty.RENTMIN)} – {fmt(selectedProperty.RENTMAX)}</div></>)}
                          {selectedProperty.LEASETERM && (<><div className="text-blue-700">Lease Term</div><div className="font-medium">{selectedProperty.LEASETERM}</div></>)}
                          {selectedProperty.DEPOSITSECURITY != null && (<><div className="text-blue-700">Security Deposit</div><div className="font-medium">{fmt(selectedProperty.DEPOSITSECURITY)}</div></>)}
                          {selectedProperty.PETSALLOWED && (<><div className="text-blue-700">Pets</div><div className="font-medium">{selectedProperty.PETSALLOWED}</div></>)}
                          {selectedProperty.AVAILABILITYDATE && (<><div className="text-blue-700">Available</div><div className="font-medium">{new Date(selectedProperty.AVAILABILITYDATE).toLocaleDateString()}</div></>)}
                        </div>
                      </div>
                    )}
                    {selectedProperty.VIRTUALTOURURLUNBRANDED && (
                      <a href={selectedProperty.VIRTUALTOURURLUNBRANDED} target="_blank" rel="noopener noreferrer"
                        className="block bg-purple-50 rounded-xl p-3 shadow-sm mb-4 border border-purple-100 text-center text-purple-700 font-medium hover:bg-purple-100 transition">
                        🎥 View Virtual Tour
                      </a>
                    )}
                    {selectedProperty.LATITUDE && selectedProperty.LONGITUDE && (
                      <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                        <h4 className="font-semibold text-gray-900 mb-2">Location</h4>
                        <p className="text-sm text-gray-600">Lat: {selectedProperty.LATITUDE.toFixed(6)}, Lng: {selectedProperty.LONGITUDE.toFixed(6)}</p>
                        {selectedProperty.WALKSCORE != null && <p className="text-sm text-gray-600 mt-1">Walk Score: <span className="font-medium">{selectedProperty.WALKSCORE}</span></p>}
                      </div>
                    )}
                    {selectedProperty.PUBLICREMARKS && (
                      <div className="bg-white rounded-xl p-4 shadow-sm">
                        <h4 className="font-semibold text-gray-900 mb-2">Description</h4>
                        <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">{selectedProperty.PUBLICREMARKS}</p>
                      </div>
                    )}
                  </>
                )}

                {/* === FINANCIAL TAB === */}
                {detailTab === 'financial' && (
                  <>
                    <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                      <h4 className="font-semibold text-gray-900 mb-3">💰 Investment Metrics</h4>
                      <div className="grid grid-cols-2 gap-y-2 text-sm">
                        {selectedProperty.CAPRATE != null && (<><div className="text-gray-500">Cap Rate</div><div className="font-bold text-green-700">{selectedProperty.CAPRATE.toFixed(2)}%</div></>)}
                        {selectedProperty.NETOPERATINGINCOME != null && (<><div className="text-gray-500">NOI</div><div className="font-medium">{fmt(selectedProperty.NETOPERATINGINCOME)}</div></>)}
                        {selectedProperty.GROSSINCOME != null && (<><div className="text-gray-500">Gross Income</div><div className="font-medium">{fmt(selectedProperty.GROSSINCOME)}</div></>)}
                        {selectedProperty.TOTALEXPENSES != null && (<><div className="text-gray-500">Total Expenses</div><div className="font-medium">{fmt(selectedProperty.TOTALEXPENSES)}</div></>)}
                        {selectedProperty.OPERATINGEXPENSE != null && (<><div className="text-gray-500">Operating Expense</div><div className="font-medium">{fmt(selectedProperty.OPERATINGEXPENSE)}</div></>)}
                        {selectedProperty.GROSSMULTIPLIER != null && (<><div className="text-gray-500">GRM</div><div className="font-medium">{selectedProperty.GROSSMULTIPLIER.toFixed(1)}x</div></>)}
                        {selectedProperty.VACANCYALLOWANCERATE != null && (<><div className="text-gray-500">Vacancy Rate</div><div className="font-medium">{selectedProperty.VACANCYALLOWANCERATE}%</div></>)}
                        {selectedProperty.TOTALACTUALRENT != null && (<><div className="text-gray-500">Actual Rent (Annual)</div><div className="font-medium">{fmt(selectedProperty.TOTALACTUALRENT)}</div></>)}
                        {selectedProperty.TOTALMONTHLYRENT != null && (<><div className="text-gray-500">Monthly Rent</div><div className="font-medium text-blue-700">{fmt(selectedProperty.TOTALMONTHLYRENT)}</div></>)}
                      </div>
                      {!selectedProperty.CAPRATE && !selectedProperty.NETOPERATINGINCOME && !selectedProperty.GROSSINCOME && (
                        <p className="text-sm text-gray-400 italic mt-2">No financial data available for this listing</p>
                      )}
                    </div>
                    <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                      <h4 className="font-semibold text-gray-900 mb-3">🏛️ Tax & Zoning</h4>
                      <div className="grid grid-cols-2 gap-y-2 text-sm">
                        {selectedProperty.TAXANNUALAMOUNT != null && (<><div className="text-gray-500">Annual Tax</div><div className="font-medium">{fmt(selectedProperty.TAXANNUALAMOUNT)}</div></>)}
                        {selectedProperty.TAXASSESSEDVALUE != null && (<><div className="text-gray-500">Assessed Value</div><div className="font-medium">{fmt(selectedProperty.TAXASSESSEDVALUE)}</div></>)}
                        {selectedProperty.TAXYEAR != null && (<><div className="text-gray-500">Tax Year</div><div className="font-medium">{selectedProperty.TAXYEAR}</div></>)}
                        {selectedProperty.ZONING && (<><div className="text-gray-500">Zoning</div><div className="font-medium">{selectedProperty.ZONING}</div></>)}
                        {selectedProperty.ZONINGDESCRIPTION && (<><div className="text-gray-500">Zoning Desc</div><div className="font-medium text-xs">{selectedProperty.ZONINGDESCRIPTION}</div></>)}
                      </div>
                    </div>
                    {selectedProperty.ASSOCIATIONYN && (
                      <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                        <h4 className="font-semibold text-gray-900 mb-3">🏘️ HOA / Association</h4>
                        <div className="grid grid-cols-2 gap-y-2 text-sm">
                          <div className="text-gray-500">HOA Fee</div>
                          <div className="font-medium">{fmt(selectedProperty.ASSOCIATIONFEE)} {selectedProperty.ASSOCIATIONFEEFREQUENCY || ''}</div>
                          {selectedProperty.ASSOCIATIONNAME && (<><div className="text-gray-500">Association</div><div className="font-medium">{selectedProperty.ASSOCIATIONNAME}</div></>)}
                        </div>
                      </div>
                    )}
                    {selectedProperty.unitTypes && selectedProperty.unitTypes.length > 0 && (
                      <div className="bg-green-50 rounded-xl p-4 shadow-sm mb-4 border border-green-100">
                        <h4 className="font-semibold text-green-900 mb-3">🏢 Unit Mix ({selectedProperty.unitTypes.length} types)</h4>
                        <div className="space-y-3">
                          {selectedProperty.unitTypes.map((unit: any, idx: number) => (
                            <div key={idx} className="bg-white rounded-lg p-3 border">
                              <div className="flex justify-between items-start">
                                <div>
                                  <p className="font-medium text-sm">{unit.UNITTYPETYPE || `Unit Type ${idx + 1}`}</p>
                                  <p className="text-xs text-gray-500">{unit.UNITTYPEBEDSTOTAL} bed / {unit.UNITTYPEBATHSTOTAL} bath{unit.UNITTYPEAREA ? ` • ${unit.UNITTYPEAREA} sqft` : ''}</p>
                                </div>
                                <div className="text-right">
                                  {unit.UNITTYPEACTUALRENT != null && <p className="font-bold text-green-700 text-sm">{fmt(unit.UNITTYPEACTUALRENT)}/mo</p>}
                                  {unit.UNITTYPEUNITSTOTAL != null && <p className="text-xs text-gray-500">{unit.UNITTYPEUNITSTOTAL} units</p>}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedProperty.CLOSEPRICE != null && (
                      <div className="bg-white rounded-xl p-4 shadow-sm">
                        <h4 className="font-semibold text-gray-900 mb-3">💵 Sale Data</h4>
                        <div className="grid grid-cols-2 gap-y-2 text-sm">
                          <div className="text-gray-500">Close Price</div><div className="font-bold">{fmt(selectedProperty.CLOSEPRICE)}</div>
                          {selectedProperty.CLOSEDATE && (<><div className="text-gray-500">Close Date</div><div className="font-medium">{new Date(selectedProperty.CLOSEDATE).toLocaleDateString()}</div></>)}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {/* === FEATURES TAB === */}
                {detailTab === 'features' && (
                  <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                    <h4 className="font-semibold text-gray-900 mb-3">🏗️ Construction & Features</h4>
                    <div className="grid grid-cols-2 gap-y-2 text-sm">
                      {selectedProperty.CONSTRUCTIONMATERIALS && (<><div className="text-gray-500">Construction</div><div className="font-medium">{selectedProperty.CONSTRUCTIONMATERIALS}</div></>)}
                      {selectedProperty.ROOF && (<><div className="text-gray-500">Roof</div><div className="font-medium">{selectedProperty.ROOF}</div></>)}
                      {selectedProperty.FOUNDATIONDETAILS && (<><div className="text-gray-500">Foundation</div><div className="font-medium">{selectedProperty.FOUNDATIONDETAILS}</div></>)}
                      {selectedProperty.LEVELS && (<><div className="text-gray-500">Levels</div><div className="font-medium">{selectedProperty.LEVELS}</div></>)}
                      {selectedProperty.POOLYN && (<><div className="text-gray-500">Pool</div><div className="font-medium text-blue-600">✅ Yes</div></>)}
                      {selectedProperty.FIREPLACEYN && (<><div className="text-gray-500">Fireplace</div><div className="font-medium">✅ {selectedProperty.FIREPLACESTOTAL || 1} fireplace(s)</div></>)}
                      {selectedProperty.WATERFRONTYN && (<><div className="text-gray-500">Waterfront</div><div className="font-medium text-blue-600">✅ Yes</div></>)}
                    </div>
                  </div>
                )}

                {/* === SCHOOLS TAB === */}
                {detailTab === 'schools' && (
                  <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                    <h4 className="font-semibold text-gray-900 mb-3">🎓 Schools</h4>
                    <div className="grid grid-cols-2 gap-y-3 text-sm">
                      {selectedProperty.ELEMENTARYSCHOOL && (<><div className="text-gray-500">Elementary</div><div className="font-medium">{selectedProperty.ELEMENTARYSCHOOL}</div></>)}
                      {selectedProperty.ELEMENTARYSCHOOLDISTRICT && (<><div className="text-gray-500">Elem. District</div><div className="font-medium text-xs">{selectedProperty.ELEMENTARYSCHOOLDISTRICT}</div></>)}
                      {selectedProperty.MIDDLEORJUNIORSCHOOL && (<><div className="text-gray-500">Middle School</div><div className="font-medium">{selectedProperty.MIDDLEORJUNIORSCHOOL}</div></>)}
                      {selectedProperty.HIGHSCHOOL && (<><div className="text-gray-500">High School</div><div className="font-medium">{selectedProperty.HIGHSCHOOL}</div></>)}
                      {selectedProperty.HIGHSCHOOLDISTRICT && (<><div className="text-gray-500">HS District</div><div className="font-medium text-xs">{selectedProperty.HIGHSCHOOLDISTRICT}</div></>)}
                    </div>
                    {!selectedProperty.ELEMENTARYSCHOOL && !selectedProperty.HIGHSCHOOL && (
                      <p className="text-sm text-gray-400 italic mt-2">No school data available for this listing</p>
                    )}
                  </div>
                )}

                {/* === HISTORY TAB === */}
                {detailTab === 'history' && (
                  <>
                    {historyLoading && (
                      <div className="flex items-center justify-center py-8">
                        <svg className="animate-spin w-6 h-6 text-amber-600 mr-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span className="text-sm text-gray-600">Loading historical data...</span>
                      </div>
                    )}
                    {historyError && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-4">{historyError}</div>
                    )}

                    {/* === Address Listing History === */}
                    {addressHistory.length > 1 && (
                      <div className="bg-amber-50 rounded-xl p-4 shadow-sm mb-4 border border-amber-200">
                        <h4 className="font-semibold text-amber-900 mb-1">🔄 Property Listed {addressHistory.length} Times</h4>
                        <p className="text-xs text-amber-700 mb-3">
                          Multiple listings at this address — potential renovation or flip activity
                        </p>

                        {/* Price change summary */}
                        {(() => {
                          const sorted = [...addressHistory].sort((a, b) =>
                            new Date(a.ONMARKETDATE || a.CLOSEDATE || '').getTime() - new Date(b.ONMARKETDATE || b.CLOSEDATE || '').getTime()
                          );
                          const first = sorted[0];
                          const last = sorted[sorted.length - 1];
                          const firstPrice = first?.CLOSEPRICE || first?.LISTPRICE || 0;
                          const lastPrice = last?.CLOSEPRICE || last?.LISTPRICE || 0;
                          const priceDiff = lastPrice - firstPrice;
                          const pctChange = firstPrice > 0 ? ((priceDiff / firstPrice) * 100) : 0;
                          const hasImprovements = sorted.some(l => l.IMPROVEMENTSAMOUNT > 0 || l.IMPROVEMENTSDESCRIPTION);
                          const conditionChanges = sorted.filter(l => l.PROPERTYCONDITION).map(l => l.PROPERTYCONDITION);

                          return (
                            <div className="grid grid-cols-3 gap-3 mb-3">
                              <div className="bg-white rounded-lg p-3 text-center">
                                <p className="text-lg font-bold text-gray-900">{fmt(firstPrice)}</p>
                                <p className="text-xs text-gray-500">First Listing ({first?.ONMARKETDATE ? new Date(first.ONMARKETDATE).getFullYear() : 'N/A'})</p>
                              </div>
                              <div className="bg-white rounded-lg p-3 text-center">
                                <p className={`text-lg font-bold ${priceDiff >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                  {priceDiff >= 0 ? '+' : ''}{fmt(priceDiff)}
                                </p>
                                <p className="text-xs text-gray-500">{pctChange >= 0 ? '+' : ''}{pctChange.toFixed(1)}% Total Change</p>
                              </div>
                              <div className="bg-white rounded-lg p-3 text-center">
                                <p className="text-lg font-bold text-gray-900">{fmt(lastPrice)}</p>
                                <p className="text-xs text-gray-500">Latest Listing ({last?.ONMARKETDATE ? new Date(last.ONMARKETDATE).getFullYear() : 'N/A'})</p>
                              </div>
                              {hasImprovements && (
                                <div className="col-span-3 bg-green-50 rounded-lg p-2 border border-green-100">
                                  <p className="text-xs text-green-800 font-medium">✅ Improvements noted: {sorted.filter(l => l.IMPROVEMENTSDESCRIPTION).map(l => l.IMPROVEMENTSDESCRIPTION).join(', ') || `$${sorted.filter(l => l.IMPROVEMENTSAMOUNT > 0).map(l => l.IMPROVEMENTSAMOUNT.toLocaleString()).join(', ')}`}</p>
                                </div>
                              )}
                              {conditionChanges.length > 1 && (
                                <div className="col-span-3 bg-blue-50 rounded-lg p-2 border border-blue-100">
                                  <p className="text-xs text-blue-800 font-medium">🏗️ Condition: {conditionChanges.join(' → ')}</p>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* Individual listings timeline */}
                        <div className="space-y-3">
                          {[...addressHistory].sort((a, b) =>
                            new Date(b.ONMARKETDATE || b.CLOSEDATE || '').getTime() - new Date(a.ONMARKETDATE || a.CLOSEDATE || '').getTime()
                          ).map((listing, idx) => (
                            <div key={listing.LISTINGKEY}
                              className={`bg-white rounded-lg p-3 border cursor-pointer transition hover:shadow-md ${
                                selectedHistoricalListing === listing.LISTINGKEY ? 'ring-2 ring-amber-500' : ''
                              }`}
                              onClick={() => setSelectedHistoricalListing(
                                selectedHistoricalListing === listing.LISTINGKEY ? null : listing.LISTINGKEY
                              )}>
                              <div className="flex gap-3">
                                {/* Thumbnail */}
                                <div className="w-20 h-16 flex-shrink-0 bg-gray-100 rounded overflow-hidden">
                                  {(listing.primaryImage || historicalImages[listing.LISTINGKEY]?.[0]?.MEDIAURL) ? (
                                    <img
                                      src={listing.primaryImage || historicalImages[listing.LISTINGKEY]?.[0]?.MEDIAURL}
                                      alt="Listing" className="w-full h-full object-cover"
                                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs">No img</div>
                                  )}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between">
                                    <div>
                                      <p className="font-bold text-sm">
                                        {listing.CLOSEPRICE ? fmt(listing.CLOSEPRICE) : fmt(listing.LISTPRICE)}
                                        {listing.CLOSEPRICE && listing.LISTPRICE && listing.CLOSEPRICE !== listing.LISTPRICE && (
                                          <span className="text-xs text-gray-400 ml-1 line-through">{fmt(listing.LISTPRICE)}</span>
                                        )}
                                      </p>
                                      <p className="text-xs text-gray-500">
                                        {listing.ONMARKETDATE ? new Date(listing.ONMARKETDATE).toLocaleDateString() : ''}
                                        {listing.CLOSEDATE ? ` → ${new Date(listing.CLOSEDATE).toLocaleDateString()}` : ''}
                                      </p>
                                    </div>
                                    <span className={`px-2 py-0.5 rounded-full text-xs ${getStatusColor(listing.STANDARDSTATUS)}`}>
                                      {listing.STANDARDSTATUS}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                                    {listing.BEDROOMSTOTAL != null && <span>{listing.BEDROOMSTOTAL}bd</span>}
                                    {listing.BATHROOMSTOTALINTEGER != null && <span>{listing.BATHROOMSTOTALINTEGER}ba</span>}
                                    {listing.LIVINGAREA != null && <span>{listing.LIVINGAREA.toLocaleString()}sf</span>}
                                    {listing.DAYSONMARKET != null && <span>{listing.DAYSONMARKET} DOM</span>}
                                    {listing.PRICEPERSQUAREFOOT != null && <span>${listing.PRICEPERSQUAREFOOT.toFixed(0)}/sf</span>}
                                  </div>
                                </div>
                              </div>

                              {/* Expanded: show images for this listing */}
                              {selectedHistoricalListing === listing.LISTINGKEY && historicalImages[listing.LISTINGKEY] && (
                                <div className="mt-3 pt-3 border-t">
                                  <p className="text-xs font-medium text-gray-600 mb-2">
                                    📷 Photos ({historicalImages[listing.LISTINGKEY].length})
                                    {listing.LISTAGENTFULLNAME && <span className="text-gray-400 ml-2">• {listing.LISTAGENTFULLNAME}</span>}
                                  </p>
                                  <div className="grid grid-cols-3 gap-1.5">
                                    {historicalImages[listing.LISTINGKEY].slice(0, 9).map((img, imgIdx) => (
                                      <div key={imgIdx} className="aspect-video bg-gray-100 rounded overflow-hidden relative group">
                                        <img src={img.MEDIAURL} alt={img.IMAGEOF || `Photo ${imgIdx + 1}`}
                                          className="w-full h-full object-cover"
                                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                        {img.IMAGEOF && (
                                          <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[10px] px-1 py-0.5 opacity-0 group-hover:opacity-100 transition">
                                            {img.IMAGEOF}
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                  {historicalImages[listing.LISTINGKEY].length > 9 && (
                                    <p className="text-xs text-gray-400 mt-1 text-center">
                                      +{historicalImages[listing.LISTINGKEY].length - 9} more photos
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* === Before / After Image Comparison === */}
                    {addressHistory.length > 1 && Object.keys(historicalImages).length > 1 && (
                      <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                        <h4 className="font-semibold text-gray-900 mb-3">📸 Before & After</h4>
                        {(() => {
                          const sortedKeys = [...addressHistory]
                            .sort((a, b) => new Date(a.ONMARKETDATE || a.CLOSEDATE || '').getTime() - new Date(b.ONMARKETDATE || b.CLOSEDATE || '').getTime())
                            .map(l => l.LISTINGKEY)
                            .filter(k => historicalImages[k] && historicalImages[k].length > 0);
                          if (sortedKeys.length < 2) return <p className="text-sm text-gray-400 italic">Not enough images for comparison</p>;
                          const firstKey = sortedKeys[0];
                          const lastKey = sortedKeys[sortedKeys.length - 1];
                          const firstImages = historicalImages[firstKey] || [];
                          const lastImages = historicalImages[lastKey] || [];
                          const firstListing = addressHistory.find(l => l.LISTINGKEY === firstKey);
                          const lastListing = addressHistory.find(l => l.LISTINGKEY === lastKey);

                          return (
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <p className="text-xs font-medium text-gray-500 mb-1.5">
                                  Before ({firstListing?.ONMARKETDATE ? new Date(firstListing.ONMARKETDATE).getFullYear() : 'Earlier'}) — {fmt(firstListing?.CLOSEPRICE || firstListing?.LISTPRICE || 0)}
                                </p>
                                <div className="space-y-1.5">
                                  {firstImages.slice(0, 4).map((img, i) => (
                                    <div key={i} className="aspect-video bg-gray-100 rounded overflow-hidden">
                                      <img src={img.MEDIAURL} alt={img.IMAGEOF || 'Before'} className="w-full h-full object-cover"
                                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                    </div>
                                  ))}
                                </div>
                              </div>
                              <div>
                                <p className="text-xs font-medium text-gray-500 mb-1.5">
                                  After ({lastListing?.ONMARKETDATE ? new Date(lastListing.ONMARKETDATE).getFullYear() : 'Latest'}) — {fmt(lastListing?.CLOSEPRICE || lastListing?.LISTPRICE || 0)}
                                </p>
                                <div className="space-y-1.5">
                                  {lastImages.slice(0, 4).map((img, i) => (
                                    <div key={i} className="aspect-video bg-gray-100 rounded overflow-hidden">
                                      <img src={img.MEDIAURL} alt={img.IMAGEOF || 'After'} className="w-full h-full object-cover"
                                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {/* === Market Appreciation Context === */}
                    {marketAppreciation.length > 0 && addressHistory.length > 1 && (
                      <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                        <h4 className="font-semibold text-gray-900 mb-2">📈 Market Appreciation vs Property</h4>
                        <p className="text-xs text-gray-500 mb-3">Isolate renovation value from market-wide price changes</p>
                        {(() => {
                          const sorted = [...addressHistory].sort((a, b) =>
                            new Date(a.ONMARKETDATE || a.CLOSEDATE || '').getTime() - new Date(b.ONMARKETDATE || b.CLOSEDATE || '').getTime()
                          );
                          const first = sorted[0];
                          const last = sorted[sorted.length - 1];
                          const firstYear = first?.ONMARKETDATE ? new Date(first.ONMARKETDATE).getFullYear() : null;
                          const lastYear = last?.ONMARKETDATE ? new Date(last.ONMARKETDATE).getFullYear() : null;
                          const firstPrice = first?.CLOSEPRICE || first?.LISTPRICE || 0;
                          const lastPrice = last?.CLOSEPRICE || last?.LISTPRICE || 0;
                          const propertyPctChange = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice * 100) : 0;

                          // Find market appreciation between those years
                          const firstYearData = marketAppreciation.find(m => m.CLOSE_YEAR === firstYear);
                          const lastYearData = marketAppreciation.find(m => m.CLOSE_YEAR === lastYear);
                          const marketFirstAvg = firstYearData?.AVG_CLOSE_PRICE || 0;
                          const marketLastAvg = lastYearData?.AVG_CLOSE_PRICE || 0;
                          const marketPctChange = marketFirstAvg > 0 ? ((marketLastAvg - marketFirstAvg) / marketFirstAvg * 100) : 0;
                          const renovationPremium = propertyPctChange - marketPctChange;

                          return (
                            <>
                              <div className="grid grid-cols-3 gap-3 mb-3">
                                <div className="bg-blue-50 rounded-lg p-3 text-center border border-blue-100">
                                  <p className={`text-lg font-bold ${propertyPctChange >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                    {propertyPctChange >= 0 ? '+' : ''}{propertyPctChange.toFixed(1)}%
                                  </p>
                                  <p className="text-xs text-blue-700">Property Change</p>
                                </div>
                                <div className="bg-gray-50 rounded-lg p-3 text-center border">
                                  <p className={`text-lg font-bold ${marketPctChange >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                    {marketPctChange >= 0 ? '+' : ''}{marketPctChange.toFixed(1)}%
                                  </p>
                                  <p className="text-xs text-gray-600">Market Change</p>
                                </div>
                                <div className={`rounded-lg p-3 text-center border ${renovationPremium >= 0 ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                                  <p className={`text-lg font-bold ${renovationPremium >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                                    {renovationPremium >= 0 ? '+' : ''}{renovationPremium.toFixed(1)}%
                                  </p>
                                  <p className="text-xs text-gray-600">Renovation Premium</p>
                                </div>
                              </div>
                              <div className="text-xs text-gray-500 space-y-1">
                                {marketAppreciation.map(yr => (
                                  <div key={yr.CLOSE_YEAR} className="flex justify-between py-1 border-b last:border-0">
                                    <span className="font-medium">{yr.CLOSE_YEAR}</span>
                                    <span>Avg: {fmt(yr.AVG_CLOSE_PRICE)}</span>
                                    <span>{yr.AVG_PRICE_PER_SQFT ? `$${yr.AVG_PRICE_PER_SQFT.toFixed(0)}/sf` : ''}</span>
                                    <span>{yr.SALES_COUNT} sales</span>
                                    <span>{yr.AVG_DAYS_ON_MARKET?.toFixed(0)} DOM</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {/* === Price Timeline (BusinessHistory) === */}
                    {addressTimeline.length > 0 && (
                      <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                        <h4 className="font-semibold text-gray-900 mb-3">📜 Detailed Price Timeline ({addressTimeline.length} events)</h4>
                        <div className="space-y-2 max-h-60 overflow-y-auto">
                          {addressTimeline.map((entry, idx) => (
                            <div key={idx} className="flex justify-between items-center py-2 border-b last:border-0 text-sm">
                              <div>
                                <p className="font-medium">{entry.STATUS}</p>
                                <p className="text-xs text-gray-500">
                                  {entry.EFFECTIVETIMESTAMP ? new Date(entry.EFFECTIVETIMESTAMP).toLocaleDateString() : 'N/A'}
                                  <span className="text-gray-300 ml-1">#{entry.LISTINGID}</span>
                                </p>
                              </div>
                              <p className="font-bold">{entry.PRICE ? fmt(entry.PRICE) : 'N/A'}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* === Single Listing Price History (original) === */}
                    {selectedProperty.priceHistory && selectedProperty.priceHistory.length > 0 && addressHistory.length <= 1 && (
                      <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                        <h4 className="font-semibold text-gray-900 mb-3">📜 Price History ({selectedProperty.priceHistory.length})</h4>
                        <div className="space-y-2">
                          {selectedProperty.priceHistory.map((entry: any, idx: number) => (
                            <div key={idx} className="flex justify-between items-center py-2 border-b last:border-0 text-sm">
                              <div>
                                <p className="font-medium">{entry.STATUS}</p>
                                <p className="text-xs text-gray-500">{entry.EFFECTIVETIMESTAMP ? new Date(entry.EFFECTIVETIMESTAMP).toLocaleDateString() : 'N/A'}</p>
                              </div>
                              <p className="font-bold">{entry.PRICE ? fmt(entry.PRICE) : 'N/A'}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* No history message */}
                    {!historyLoading && addressHistory.length <= 1 && (!selectedProperty.priceHistory || selectedProperty.priceHistory.length === 0) && (
                      <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                        <p className="text-sm text-gray-400 italic">No historical listing data available for this property</p>
                      </div>
                    )}

                    {/* Single listing — show rooms and open houses */}
                    {addressHistory.length <= 1 && (
                      <>
                        {selectedProperty.rooms && selectedProperty.rooms.length > 0 && (
                          <div className="bg-white rounded-xl p-4 shadow-sm mb-4">
                            <h4 className="font-semibold text-gray-900 mb-3">🚪 Rooms ({selectedProperty.rooms.length})</h4>
                            <div className="space-y-2">
                              {selectedProperty.rooms.map((room: any, idx: number) => (
                                <div key={idx} className="flex justify-between items-center text-sm py-1 border-b last:border-0">
                                  <span className="font-medium">{room.ROOMTYPE || 'Room'}</span>
                                  <span className="text-gray-500">{room.ROOMLEVEL || ''}{room.ROOMLENGTH && room.ROOMWIDTH ? ` • ${room.ROOMLENGTH}×${room.ROOMWIDTH}` : ''}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {selectedProperty.openHouses && selectedProperty.openHouses.length > 0 && (
                          <div className="bg-yellow-50 rounded-xl p-4 shadow-sm mb-4 border border-yellow-100">
                            <h4 className="font-semibold text-yellow-900 mb-3">🏠 Open Houses</h4>
                            {selectedProperty.openHouses.map((oh: any, idx: number) => (
                              <div key={idx} className="text-sm py-1">{oh.OPENHOUSEDATE ? new Date(oh.OPENHOUSEDATE).toLocaleDateString() : 'TBD'}</div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t bg-gray-50 text-center text-sm text-gray-500">
            REdistribute MultiClass MLS Data via Snowflake • {properties.length} properties loaded
            {availableStates.length > 0 && ` • ${availableStates.length} states`}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MLSDataExplorerModal;