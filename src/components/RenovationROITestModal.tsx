/**
 * RenovationROITestModal.tsx
 * 
 * A standalone test modal for the Localized Renovation ROI Engine.
 * Self-contained with no external component dependencies.
 * Matches the MLSDataExplorerModal pattern.
 */

import React, { useState } from 'react';

interface RenovationROITestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface RenovationCandidate {
  ADDRESS?: string;
  FULL_ADDRESS?: string;
  address?: string;
  CITY?: string;
  city?: string;
  STATE?: string;
  state?: string;
  ZIP_CODE?: string;
  zip_code?: string;
  PROPERTY_TYPE?: string;
  property_type?: string;
  BEDS?: number;
  beds?: number;
  BATHS?: number;
  baths?: number;
  SQFT?: number;
  sqft?: number;
  YEAR_BUILT?: number;
  year_built?: number;
  TOTAL_LISTINGS?: number;
  total_listings?: number;
  BEFORE_LISTING_KEY?: string;
  before_listing_key?: string;
  BEFORE_LIST_DATE?: string;
  before_list_date?: string;
  BEFORE_SALE_DATE?: string;
  before_sale_date?: string;
  BEFORE_LIST_PRICE?: number;
  before_list_price?: number;
  BEFORE_SALE_PRICE?: number;
  before_sale_price?: number;
  BEFORE_PHOTO_COUNT?: number;
  before_photo_count?: number;
  AFTER_LISTING_KEY?: string;
  after_listing_key?: string;
  AFTER_LIST_DATE?: string;
  after_list_date?: string;
  AFTER_SALE_DATE?: string;
  after_sale_date?: string;
  AFTER_LIST_PRICE?: number;
  after_list_price?: number;
  AFTER_SALE_PRICE?: number;
  after_sale_price?: number;
  AFTER_PHOTO_COUNT?: number;
  after_photo_count?: number;
  PRICE_INCREASE?: number;
  price_increase?: number;
  PRICE_INCREASE_PCT?: number;
  price_increase_pct?: number;
  HOLDING_MONTHS?: number;
  holding_months?: number;
  // Extended fields for full analysis
  beforePhotos?: string[];
  afterPhotos?: string[];
  beforeCondition?: string;
  afterCondition?: string;
  beforeRemarks?: string;
  afterRemarks?: string;
}

// Comprehensive Analysis Result Interface (matches new backend response)
interface RenovationAnalysisResult {
  photoAnalysis: {
    renovationsDetected: Array<{
      category: string;
      scope: string;
      description: string;
      confidence: number;
      qualityLevel: string;
      beforeDescription: string;
      afterDescription: string;
      estimatedCost: number;
      costRange?: { low: number; high: number };
      positiveImpact?: boolean;
      warning?: string;
    }>;
    overallConfidence: number;
    notes: string;
    overallAssessment?: 'positive' | 'mixed' | 'negative' | 'neutral';
    beforePhotos: string[];
    afterPhotos: string[];
    beforePhotoCount: number;
    afterPhotoCount: number;
  };
  roiCalculation: {
    // Price data
    beforePrice: number;
    afterPrice: number;
    rawPriceIncrease: number;
    rawPriceIncreasePercent: number;
    // Natural appreciation (key differentiator)
    naturalAppreciation: {
      amount: number;
      percent: number;
      region: string;
    };
    // Renovation-attributed value (TRUE renovation gain)
    renovationAttributedValue: number;
    renovationAttributedPercent: number;
    // Costs & profit
    totalEstimatedCost: number;
    netProfit: number;
    // ROI metrics
    valueROI: number | null;
    annualizedValueROI: number | null;
    simpleROI: number;
    // Verdict
    profitability: 'profitable' | 'break-even' | 'loss';
    holdingMonths: number;
    // Rankings
    renovationRankings: Array<{
      category: string;
      scope: string;
      cost: number;
      estimatedValueGain: number;
      roi: number;
      ranking: 'excellent' | 'good' | 'fair' | 'poor';
      positiveImpact: boolean;
    }>;
    bestRenovation: {
      category: string;
      roi: number;
    } | null;
  };
  rentAnalysis?: {
    beforeRent: number;
    afterRent: number;
    rentIncrease: number;
    rentIncreasePercent: number;
    annualRentIncrease: number;
    rentROI: number;
    paybackMonths: number;
    verdict: 'excellent' | 'good' | 'fair' | 'poor';
  };
  taxValidation: {
    status: 'validated' | 'partial' | 'mismatch' | 'unvalidated';
    message: string;
    taxDelta?: number;
    taxRatio?: number;
  };
  stratification: {
    priceTier: string;
    yearBuiltBracket: string;
    propertyType: string;
    state: string;
    zipCode: string;
  };
  confidence: {
    score: number;
    level: 'high' | 'medium' | 'low';
    dataQuality: 'verified' | 'estimated' | 'low_confidence';
    flags: string[];
  };
  negativeSignals: Array<{
    category: string;
    warning: string;
    confidence: number;
  }>;
  marketTiming: {
    marketHeat: 'hot' | 'warm' | 'normal' | 'cold';
    holdingPeriodMonths: number;
    naturalAppreciationPercent: number;
    avgAnnualAppreciation: number;
    timing: string;
  };
}

const RenovationROITestModal: React.FC<RenovationROITestModalProps> = ({ isOpen, onClose }) => {
  const [zipCode, setZipCode] = useState('75001');
  const [addressSearch, setAddressSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Photo viewer state
  const [showPhotoGallery, setShowPhotoGallery] = useState(false);
  const [activePhotoSet, setActivePhotoSet] = useState<'before' | 'after'>('before');
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0);
  
  // Data states
  const [candidates, setCandidates] = useState<RenovationCandidate[]>([]);
  const [areaStats, setAreaStats] = useState<any>(null);
  const [areaSummary, setAreaSummary] = useState<any>(null);
  const [similarRenos, setSimilarRenos] = useState<any[]>([]);
  
  // Analysis state
  const [analysisResult, setAnalysisResult] = useState<RenovationAnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  
  // Selected item for detail view
  const [selectedCandidate, setSelectedCandidate] = useState<RenovationCandidate | null>(null);
  
  // Status tracking
  const [statuses, setStatuses] = useState({
    candidates: 'idle' as 'idle' | 'loading' | 'success' | 'error',
    areaStats: 'idle' as 'idle' | 'loading' | 'success' | 'error',
    areaSummary: 'idle' as 'idle' | 'loading' | 'success' | 'error',
    similar: 'idle' as 'idle' | 'loading' | 'success' | 'error',
  });

  const updateStatus = (key: keyof typeof statuses, value: typeof statuses[keyof typeof statuses]) => {
    setStatuses(prev => ({ ...prev, [key]: value }));
  };

  // Fetch candidates
  const fetchCandidates = async () => {
    updateStatus('candidates', 'loading');
    try {
      const res = await fetch(`/api/renovation-roi/candidates?zipCode=${zipCode}&limit=50`);
      const data = await res.json();
      console.log('[RenovationROITestModal] Candidates response:', data);
      if (data.ok) {
        const candidateList = data.data || [];
        console.log('[RenovationROITestModal] Setting candidates:', candidateList.length, 'items');
        setCandidates(candidateList);
        updateStatus('candidates', 'success');
      } else {
        throw new Error(data.error || 'Failed to fetch candidates');
      }
    } catch (err: any) {
      console.error('[RenovationROITestModal] Fetch candidates error:', err);
      updateStatus('candidates', 'error');
      setError(err.message);
    }
  };

  // Fetch area stats
  const fetchAreaStats = async () => {
    updateStatus('areaStats', 'loading');
    try {
      const res = await fetch(`/api/renovation-roi/area-stats/${zipCode}`);
      const data = await res.json();
      if (data.ok) {
        setAreaStats(data.data);
        updateStatus('areaStats', 'success');
      } else {
        throw new Error(data.error || 'Failed to fetch area stats');
      }
    } catch (err: any) {
      updateStatus('areaStats', 'error');
      setError(err.message);
    }
  };

  // Fetch area summary
  const fetchAreaSummary = async () => {
    updateStatus('areaSummary', 'loading');
    try {
      const res = await fetch(`/api/renovation-roi/area-summary/${zipCode}`);
      const data = await res.json();
      if (data.ok) {
        setAreaSummary(data.summary || data.areaStats);
        updateStatus('areaSummary', 'success');
      } else {
        throw new Error(data.error || 'Failed to fetch area summary');
      }
    } catch (err: any) {
      updateStatus('areaSummary', 'error');
      setError(err.message);
    }
  };

  // Fetch similar renovations
  const fetchSimilar = async () => {
    updateStatus('similar', 'loading');
    try {
      const params = new URLSearchParams({
        zipCode,
        minPriceIncreasePct: '10',
        maxPriceIncreasePct: '200',
        limit: '30'
      });
      const res = await fetch(`/api/renovation-roi/similar?${params}`);
      const data = await res.json();
      if (data.ok) {
        setSimilarRenos(data.data || []);
        updateStatus('similar', 'success');
      } else {
        throw new Error(data.error || 'Failed to fetch similar renovations');
      }
    } catch (err: any) {
      updateStatus('similar', 'error');
      setError(err.message);
    }
  };

  // Load demo property (6323 SW Delker Rd - our known multi-sale property)
  const loadDemoProperty = async () => {
    setLoading(true);
    setError(null);
    setAnalysisResult(null);
    updateStatus('candidates', 'loading');
    
    try {
      const res = await fetch('/api/renovation-roi/demo');
      const data = await res.json();
      console.log('[RenovationROITestModal] Demo property response:', data);
      
      if (data.ok && data.data) {
        // Convert the detailed format to our candidate format for display
        const demoCandidate: RenovationCandidate = {
          address: data.data.address,
          city: data.data.city,
          state: data.data.state,
          zip_code: data.data.zipCode,
          property_type: data.data.propertyType,
          beds: data.data.beds,
          baths: data.data.baths,
          sqft: data.data.sqft,
          year_built: data.data.yearBuilt,
          total_listings: 2,
          before_listing_key: data.data.before?.listingKey,
          before_list_date: data.data.before?.listDate,
          before_sale_date: data.data.before?.saleDate,
          before_list_price: data.data.before?.listPrice,
          before_sale_price: data.data.before?.salePrice,
          before_photo_count: data.data.before?.photos?.length || 0,
          after_listing_key: data.data.after?.listingKey,
          after_list_date: data.data.after?.listDate,
          after_sale_date: data.data.after?.saleDate,
          after_list_price: data.data.after?.listPrice,
          after_sale_price: data.data.after?.salePrice,
          after_photo_count: data.data.after?.photos?.length || 0,
          price_increase: data.data.metrics?.priceIncrease,
          price_increase_pct: parseFloat(data.data.metrics?.priceIncreasePercent) || 0,
          holding_months: data.data.metrics?.holdingMonths,
          // Store full photo arrays and details for analysis
          beforePhotos: data.data.before?.photos || [],
          afterPhotos: data.data.after?.photos || [],
          beforeCondition: data.data.before?.condition,
          afterCondition: data.data.after?.condition,
          beforeRemarks: data.data.before?.publicRemarks,
          afterRemarks: data.data.after?.publicRemarks
        };
        
        setCandidates([demoCandidate]);
        setSelectedCandidate(demoCandidate);
        updateStatus('candidates', 'success');
        setZipCode('97062'); // Update zip to match demo property
      } else {
        throw new Error(data.error || 'Failed to load demo property');
      }
    } catch (err: any) {
      console.error('[RenovationROITestModal] Demo property error:', err);
      updateStatus('candidates', 'error');
      setError(err.message);
    }
    
    setLoading(false);
  };

  // Search by address
  const searchByAddress = async () => {
    if (!addressSearch.trim()) {
      setError('Please enter an address to search');
      return;
    }
    
    setLoading(true);
    setError(null);
    setAnalysisResult(null);
    updateStatus('candidates', 'loading');
    
    try {
      const res = await fetch(`/api/renovation-roi/search-address?address=${encodeURIComponent(addressSearch)}`);
      const data = await res.json();
      console.log('[RenovationROITestModal] Address search response:', data);
      
      if (data.ok && data.data) {
        // Same format as demo property
        const candidate: RenovationCandidate = {
          address: data.data.address,
          city: data.data.city,
          state: data.data.state,
          zip_code: data.data.zipCode,
          property_type: data.data.propertyType,
          beds: data.data.beds,
          baths: data.data.baths,
          sqft: data.data.sqft,
          year_built: data.data.yearBuilt,
          total_listings: data.data.totalListings || 1,
          before_listing_key: data.data.before?.listingKey,
          before_list_date: data.data.before?.listDate,
          before_sale_date: data.data.before?.saleDate,
          before_list_price: data.data.before?.listPrice,
          before_sale_price: data.data.before?.salePrice,
          before_photo_count: data.data.before?.photos?.length || 0,
          after_listing_key: data.data.after?.listingKey,
          after_list_date: data.data.after?.listDate,
          after_sale_date: data.data.after?.saleDate,
          after_list_price: data.data.after?.listPrice,
          after_sale_price: data.data.after?.salePrice,
          after_photo_count: data.data.after?.photos?.length || 0,
          price_increase: data.data.metrics?.priceIncrease,
          price_increase_pct: parseFloat(data.data.metrics?.priceIncreasePercent) || 0,
          holding_months: data.data.metrics?.holdingMonths,
          beforePhotos: data.data.before?.photos || [],
          afterPhotos: data.data.after?.photos || [],
          beforeCondition: data.data.before?.condition,
          afterCondition: data.data.after?.condition,
          beforeRemarks: data.data.before?.publicRemarks,
          afterRemarks: data.data.after?.publicRemarks
        };
        
        setCandidates([candidate]);
        setSelectedCandidate(candidate);
        updateStatus('candidates', 'success');
        setZipCode(data.data.zipCode || '');
      } else {
        throw new Error(data.error || 'Property not found or no multi-sale history');
      }
    } catch (err: any) {
      console.error('[RenovationROITestModal] Address search error:', err);
      updateStatus('candidates', 'error');
      setError(err.message);
    }
    
    setLoading(false);
  };

  // Analyze renovations using AI photo comparison - FULL ANALYSIS
  const analyzeRenovations = async () => {
    if (!selectedCandidate) {
      setError('Please select a property first');
      return;
    }
    
    const beforePhotos = selectedCandidate.beforePhotos || [];
    const afterPhotos = selectedCandidate.afterPhotos || [];
    
    if (beforePhotos.length === 0 || afterPhotos.length === 0) {
      setError('No photos available for analysis');
      return;
    }
    
    setAnalyzing(true);
    setError(null);
    
    try {
      console.log('[RenovationROITestModal] Starting FULL AI analysis with', beforePhotos.length, 'before and', afterPhotos.length, 'after photos');
      
      const res = await fetch('/api/renovation-roi/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Photos
          beforePhotos,
          afterPhotos,
          // Price data
          beforePrice: getValue(selectedCandidate, 'before_sale_price', 'BEFORE_SALE_PRICE'),
          afterPrice: getValue(selectedCandidate, 'after_sale_price', 'AFTER_SALE_PRICE'),
          // Date data
          beforeDate: getValue(selectedCandidate, 'before_sale_date', 'BEFORE_SALE_DATE'),
          afterDate: getValue(selectedCandidate, 'after_sale_date', 'AFTER_SALE_DATE'),
          // Property identification
          propertyId: getValue(selectedCandidate, 'address', 'ADDRESS'),
          state: getValue(selectedCandidate, 'state', 'STATE'),
          // Extended fields for full analysis
          zipCode: getValue(selectedCandidate, 'zip_code', 'ZIP_CODE'),
          propertyType: getValue(selectedCandidate, 'property_type', 'PROPERTY_TYPE'),
          yearBuilt: getValue(selectedCandidate, 'year_built', 'YEAR_BUILT'),
          sqft: getValue(selectedCandidate, 'sqft', 'SQFT'),
          beds: getValue(selectedCandidate, 'beds', 'BEDS'),
          baths: getValue(selectedCandidate, 'baths', 'BATHS')
          // Note: beforeRent, afterRent, beforeTaxAssessment, afterTaxAssessment 
          // would be added if we had that data from MLS or ATTOM
        })
      });
      
      const data = await res.json();
      console.log('[RenovationROITestModal] Full analysis response:', data);
      
      if (data.ok) {
        setAnalysisResult(data.data);
      } else {
        throw new Error(data.error || 'Analysis failed');
      }
    } catch (err: any) {
      console.error('[RenovationROITestModal] Analysis error:', err);
      setError(err.message);
    }
    
    setAnalyzing(false);
  };

  // Run all tests
  const runAllTests = async () => {
    setLoading(true);
    setError(null);
    setSelectedCandidate(null);
    setAnalysisResult(null);
    
    await Promise.all([
      fetchCandidates(),
      fetchAreaStats(),
      fetchAreaSummary(),
      fetchSimilar()
    ]);
    
    setLoading(false);
  };

  // Helper functions
  const getValue = (obj: any, ...keys: string[]) => {
    for (const key of keys) {
      if (obj[key] !== undefined) return obj[key];
    }
    return null;
  };

  const formatCurrency = (val: number | null | undefined) => {
    if (val == null) return '-';
    return '$' + val.toLocaleString();
  };

  const formatPercent = (val: number | null | undefined) => {
    if (val == null) return '-';
    return val.toFixed(1) + '%';
  };

  const formatDate = (val: string | null | undefined) => {
    if (!val) return '-';
    return val.split('T')[0];
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'idle':
        return <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">Idle</span>;
      case 'loading':
        return <span className="px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 animate-pulse">Loading...</span>;
      case 'success':
        return <span className="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">✓ Success</span>;
      case 'error':
        return <span className="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">✗ Error</span>;
      default:
        return null;
    }
  };

  // Unused variable to silence warning
  void similarRenos;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black bg-opacity-50 overflow-hidden">
      <div className="h-full flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden">
          
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-amber-500 to-orange-600">
            <div>
              <h2 className="text-2xl font-bold text-white">🔧 Renovation ROI Test</h2>
              <p className="text-amber-100 text-sm mt-1">Test Zillow renovation candidate queries</p>
            </div>
            <button 
              onClick={onClose}
              className="text-white hover:bg-white/20 rounded-full p-2 transition"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Search Controls */}
          <div className="p-4 border-b bg-gray-50">
            <div className="flex flex-wrap gap-4 items-end">
              {/* Address Search */}
              <div className="flex-1 min-w-[250px]">
                <label className="block text-sm font-medium text-gray-700 mb-1">Search by Address</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                    placeholder="e.g. 6323 SW Delker Rd"
                    value={addressSearch}
                    onChange={(e) => setAddressSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && searchByAddress()}
                  />
                  <button
                    onClick={searchByAddress}
                    disabled={loading || !addressSearch.trim()}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
                  >
                    {loading ? (
                      <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <>🔎 Search</>
                    )}
                  </button>
                </div>
              </div>

              <div className="text-gray-400">or</div>

              {/* ZIP Code */}
              <div className="w-32">
                <label className="block text-sm font-medium text-gray-700 mb-1">ZIP Code</label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                  placeholder="e.g. 75001"
                  value={zipCode}
                  onChange={(e) => setZipCode(e.target.value)}
                />
              </div>

              {/* Search Button */}
              <button
                onClick={runAllTests}
                disabled={loading || !zipCode}
                className="px-6 py-2 bg-amber-600 text-white rounded-lg font-semibold hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Searching...
                  </>
                ) : (
                  <>🔍 Run All Tests</>
                )}
              </button>

              {/* Load Demo Button */}
              <button
                onClick={loadDemoProperty}
                disabled={loading}
                className="px-6 py-2 bg-green-600 text-white rounded-lg font-semibold hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
                title="Load 6323 SW Delker Rd - a property that sold twice in our database"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Loading...
                  </>
                ) : (
                  <>🏠 Load Demo Property</>
                )}
              </button>

              {/* Status Indicators */}
              <div className="flex flex-wrap gap-3 ml-auto text-xs">
                <div className="flex items-center gap-1">
                  <span className="text-gray-600">Candidates:</span>
                  {getStatusBadge(statuses.candidates)}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-gray-600">Stats:</span>
                  {getStatusBadge(statuses.areaStats)}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-gray-600">Summary:</span>
                  {getStatusBadge(statuses.areaSummary)}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-gray-600">Similar:</span>
                  {getStatusBadge(statuses.similar)}
                </div>
              </div>
            </div>
            
            {error && (
              <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                ⚠️ {error}
              </div>
            )}
          </div>

          {/* Main Content */}
          <div className="flex-1 overflow-hidden flex">
            {/* Candidates List */}
            <div className={`${selectedCandidate ? 'w-1/2' : 'w-full'} overflow-y-auto border-r`}>
              {candidates.length === 0 && !loading && (
                <div className="flex flex-col items-center justify-center h-full text-gray-500">
                  <svg className="w-16 h-16 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                  <p className="text-lg">Enter a ZIP code to find renovation candidates</p>
                  <p className="text-sm mt-1">Properties that sold twice with price increases</p>
                </div>
              )}

              {candidates.length > 0 && (
                <div className="p-4 space-y-3">
                  <div className="text-sm text-gray-600 mb-2">
                    Found {candidates.length} renovation candidates in {zipCode}
                  </div>
                  
                  {candidates.map((c, idx) => {
                    const address = getValue(c, 'ADDRESS', 'FULL_ADDRESS', 'address') || 'Unknown Address';
                    const city = getValue(c, 'CITY', 'city') || '';
                    const state = getValue(c, 'STATE', 'state') || '';
                    const beforePrice = getValue(c, 'BEFORE_SALE_PRICE', 'before_sale_price') || 0;
                    const afterPrice = getValue(c, 'AFTER_SALE_PRICE', 'after_sale_price') || 0;
                    const priceIncrease = getValue(c, 'PRICE_INCREASE', 'price_increase') || (afterPrice - beforePrice);
                    const pctIncrease = getValue(c, 'PRICE_INCREASE_PCT', 'price_increase_pct') || (beforePrice > 0 ? (priceIncrease / beforePrice * 100) : 0);
                    const holdingMonths = getValue(c, 'HOLDING_MONTHS', 'holding_months') || 0;
                    const isSelected = selectedCandidate === c;

                    return (
                      <div
                        key={idx}
                        onClick={() => setSelectedCandidate(c)}
                        className={`bg-white border rounded-xl p-4 cursor-pointer hover:shadow-md transition ${
                          isSelected ? 'ring-2 ring-amber-500 border-amber-500' : 'border-gray-200'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <h4 className="font-semibold text-gray-900">{address}</h4>
                            <p className="text-sm text-gray-500">{city}, {state}</p>
                          </div>
                          <div className={`text-right ${priceIncrease >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            <div className="font-bold">+{formatCurrency(priceIncrease)}</div>
                            <div className="text-sm">({formatPercent(pctIncrease)})</div>
                          </div>
                        </div>
                        
                        <div className="mt-3 flex gap-4 text-sm text-gray-600">
                          <div>
                            <span className="text-gray-400">Before:</span> {formatCurrency(beforePrice)}
                          </div>
                          <div>
                            <span className="text-gray-400">After:</span> {formatCurrency(afterPrice)}
                          </div>
                          <div>
                            <span className="text-gray-400">Holding:</span> {holdingMonths} months
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Detail Panel */}
            {selectedCandidate && (
              <div className="w-1/2 overflow-y-auto p-4 bg-gray-50">
                <div className="bg-white rounded-xl border p-6">
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="text-xl font-bold text-gray-900">
                      {getValue(selectedCandidate, 'ADDRESS', 'FULL_ADDRESS', 'address')}
                    </h3>
                    <button
                      onClick={() => setSelectedCandidate(null)}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div className="space-y-6">
                    {/* Property Details */}
                    <div>
                      <h4 className="font-semibold text-gray-700 mb-2">Property Details</h4>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="bg-gray-50 p-2 rounded">
                          <span className="text-gray-500">Type:</span>{' '}
                          <span className="font-medium">{getValue(selectedCandidate, 'PROPERTY_TYPE', 'property_type') || '-'}</span>
                        </div>
                        <div className="bg-gray-50 p-2 rounded">
                          <span className="text-gray-500">Beds:</span>{' '}
                          <span className="font-medium">{getValue(selectedCandidate, 'BEDS', 'beds') || '-'}</span>
                        </div>
                        <div className="bg-gray-50 p-2 rounded">
                          <span className="text-gray-500">Baths:</span>{' '}
                          <span className="font-medium">{getValue(selectedCandidate, 'BATHS', 'baths') || '-'}</span>
                        </div>
                        <div className="bg-gray-50 p-2 rounded">
                          <span className="text-gray-500">Sqft:</span>{' '}
                          <span className="font-medium">{getValue(selectedCandidate, 'SQFT', 'sqft')?.toLocaleString() || '-'}</span>
                        </div>
                        <div className="bg-gray-50 p-2 rounded">
                          <span className="text-gray-500">Year Built:</span>{' '}
                          <span className="font-medium">{getValue(selectedCandidate, 'YEAR_BUILT', 'year_built') || '-'}</span>
                        </div>
                        <div className="bg-gray-50 p-2 rounded">
                          <span className="text-gray-500">Total Listings:</span>{' '}
                          <span className="font-medium">{getValue(selectedCandidate, 'TOTAL_LISTINGS', 'total_listings') || '-'}</span>
                        </div>
                      </div>
                    </div>

                    {/* Before Sale */}
                    <div>
                      <h4 className="font-semibold text-gray-700 mb-2">🔴 Before Sale</h4>
                      <div className="bg-red-50 border border-red-100 rounded-lg p-4">
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-gray-500">Sale Price:</span>{' '}
                            <span className="font-bold text-lg">{formatCurrency(getValue(selectedCandidate, 'BEFORE_SALE_PRICE', 'before_sale_price'))}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">List Price:</span>{' '}
                            <span className="font-medium">{formatCurrency(getValue(selectedCandidate, 'BEFORE_LIST_PRICE', 'before_list_price'))}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Sale Date:</span>{' '}
                            <span className="font-medium">{formatDate(getValue(selectedCandidate, 'BEFORE_SALE_DATE', 'before_sale_date'))}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Photos:</span>{' '}
                            <span className="font-medium">{getValue(selectedCandidate, 'BEFORE_PHOTO_COUNT', 'before_photo_count') || '-'}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* After Sale */}
                    <div>
                      <h4 className="font-semibold text-gray-700 mb-2">🟢 After Sale (Post-Renovation)</h4>
                      <div className="bg-green-50 border border-green-100 rounded-lg p-4">
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-gray-500">Sale Price:</span>{' '}
                            <span className="font-bold text-lg">{formatCurrency(getValue(selectedCandidate, 'AFTER_SALE_PRICE', 'after_sale_price'))}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">List Price:</span>{' '}
                            <span className="font-medium">{formatCurrency(getValue(selectedCandidate, 'AFTER_LIST_PRICE', 'after_list_price'))}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Sale Date:</span>{' '}
                            <span className="font-medium">{formatDate(getValue(selectedCandidate, 'AFTER_SALE_DATE', 'after_sale_date'))}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Photos:</span>{' '}
                            <span className="font-medium">{getValue(selectedCandidate, 'AFTER_PHOTO_COUNT', 'after_photo_count') || '-'}</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Photo Gallery Section */}
                    {((selectedCandidate?.beforePhotos?.length ?? 0) > 0 || (selectedCandidate?.afterPhotos?.length ?? 0) > 0) && (
                      <div>
                        <h4 className="font-semibold text-gray-700 mb-2">📸 Property Photos</h4>
                        <div className="border border-gray-200 rounded-lg overflow-hidden">
                          {/* Toggle buttons */}
                          <div className="flex bg-gray-100 border-b">
                            <button
                              onClick={() => setActivePhotoSet('before')}
                              className={`flex-1 py-2 px-4 text-sm font-medium transition ${
                                activePhotoSet === 'before'
                                  ? 'bg-red-500 text-white'
                                  : 'text-gray-600 hover:bg-gray-200'
                              }`}
                            >
                              🔴 Before ({selectedCandidate?.beforePhotos?.length || 0})
                            </button>
                            <button
                              onClick={() => setActivePhotoSet('after')}
                              className={`flex-1 py-2 px-4 text-sm font-medium transition ${
                                activePhotoSet === 'after'
                                  ? 'bg-green-500 text-white'
                                  : 'text-gray-600 hover:bg-gray-200'
                              }`}
                            >
                              🟢 After ({selectedCandidate?.afterPhotos?.length || 0})
                            </button>
                          </div>
                          
                          {/* Photo grid */}
                          <div className="p-3 bg-gray-50">
                            <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                              {(activePhotoSet === 'before' ? selectedCandidate?.beforePhotos : selectedCandidate?.afterPhotos)?.map((url, idx) => (
                                <div
                                  key={idx}
                                  onClick={() => {
                                    setSelectedPhotoIndex(idx);
                                    setShowPhotoGallery(true);
                                  }}
                                  className="relative aspect-square cursor-pointer group overflow-hidden rounded-lg border border-gray-200 bg-white"
                                >
                                  <img
                                    src={url}
                                    alt={`${activePhotoSet} photo ${idx + 1}`}
                                    className="w-full h-full object-cover group-hover:scale-110 transition"
                                    loading="lazy"
                                    onError={(e) => {
                                      (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23eee" width="100" height="100"/><text x="50" y="50" text-anchor="middle" dy=".35em" font-size="12" fill="%23999">No image</text></svg>';
                                    }}
                                  />
                                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition flex items-center justify-center">
                                    <span className="text-white opacity-0 group-hover:opacity-100 transition font-medium">
                                      View
                                    </span>
                                  </div>
                                  <span className="absolute bottom-1 right-1 text-xs bg-black/60 text-white px-1 rounded">
                                    {idx + 1}
                                  </span>
                                </div>
                              )) || <p className="text-gray-500 text-sm col-span-3 text-center py-4">No photos available</p>}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ROI Summary */}
                    <div>
                      <h4 className="font-semibold text-gray-700 mb-2">📈 ROI Summary</h4>
                      <div className="bg-amber-50 border border-amber-100 rounded-lg p-4">
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-gray-500">Price Increase:</span>{' '}
                            <span className="font-bold text-green-600 text-lg">
                              {formatCurrency(getValue(selectedCandidate, 'PRICE_INCREASE', 'price_increase'))}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-500">% Increase:</span>{' '}
                            <span className="font-bold text-green-600 text-lg">
                              {formatPercent(getValue(selectedCandidate, 'PRICE_INCREASE_PCT', 'price_increase_pct'))}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-500">Holding Period:</span>{' '}
                            <span className="font-medium">{getValue(selectedCandidate, 'HOLDING_MONTHS', 'holding_months')} months</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Analyze Renovations Button */}
                    <div className="pt-2">
                      <button
                        onClick={analyzeRenovations}
                        disabled={analyzing || !selectedCandidate?.beforePhotos?.length}
                        className="w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg font-bold hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
                      >
                        {analyzing ? (
                          <>
                            <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Analyzing {selectedCandidate?.beforePhotos?.length || 0} + {selectedCandidate?.afterPhotos?.length || 0} photos with AI...
                          </>
                        ) : (
                          <>🤖 Analyze Renovations with AI ({(selectedCandidate?.beforePhotos?.length || 0) + (selectedCandidate?.afterPhotos?.length || 0)} photos)</>
                        )}
                      </button>
                      <p className="text-xs text-gray-500 mt-1 text-center">
                        Uses GPT-4 Vision to detect renovations and calculate true ROI
                      </p>
                    </div>

                    {/* AI Analysis Results */}
                    {analysisResult && (
                      <div className="space-y-4 mt-4">
                        <h4 className="font-bold text-lg text-purple-700 flex items-center gap-2">
                          🤖 AI Renovation Analysis Complete
                        </h4>
                        
                        {/* Detected Renovations */}
                        {analysisResult.photoAnalysis?.renovationsDetected?.length > 0 ? (
                          <div className="space-y-3">
                            <h5 className="font-semibold text-gray-700">
                              Detected {analysisResult.photoAnalysis.renovationsDetected.length} Renovations:
                            </h5>
                            {analysisResult.photoAnalysis.renovationsDetected.map((reno, idx) => (
                              <div key={idx} className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                                <div className="flex items-start justify-between">
                                  <div>
                                    <span className="inline-block px-2 py-0.5 bg-purple-600 text-white text-xs rounded-full uppercase">
                                      {reno.category}
                                    </span>
                                    <span className="ml-2 inline-block px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs rounded-full">
                                      {reno.scope}
                                    </span>
                                    <span className="ml-2 inline-block px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">
                                      {reno.qualityLevel}
                                    </span>
                                    {reno.positiveImpact === false && (
                                      <span className="ml-2 inline-block px-2 py-0.5 bg-red-100 text-red-700 text-xs rounded-full">
                                        ⚠️ Negative
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-right">
                                    <div className="font-bold text-green-600">{formatCurrency(reno.estimatedCost)}</div>
                                    <div className="text-xs text-gray-500">{Math.round(reno.confidence * 100)}% confidence</div>
                                  </div>
                                </div>
                                <p className="mt-2 text-sm text-gray-700">{reno.description}</p>
                                {reno.warning && (
                                  <p className="mt-1 text-xs text-orange-600 bg-orange-50 p-1 rounded">⚠️ {reno.warning}</p>
                                )}
                                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                                  <div className="bg-red-50 p-2 rounded">
                                    <span className="font-semibold text-red-600">Before:</span> {reno.beforeDescription}
                                  </div>
                                  <div className="bg-green-50 p-2 rounded">
                                    <span className="font-semibold text-green-600">After:</span> {reno.afterDescription}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-yellow-700">
                            <p className="font-semibold">No renovations detected</p>
                            <p className="text-sm mt-1">{analysisResult.photoAnalysis?.notes || 'The AI could not identify significant changes between the before and after photos.'}</p>
                          </div>
                        )}

                        {/* COMPLETE ROI BREAKDOWN - The key differentiator */}
                        {analysisResult.roiCalculation && (
                          <div className="space-y-4">
                            {/* Natural Appreciation Section - NEW */}
                            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4">
                              <h5 className="font-bold text-blue-700 mb-3">📊 Price & Appreciation Breakdown</h5>
                              <div className="space-y-2 text-sm">
                                <div className="flex justify-between items-center py-1 border-b border-blue-100">
                                  <span className="text-gray-600">Raw Price Increase:</span>
                                  <span className="font-bold text-lg text-green-600">
                                    {formatCurrency(analysisResult.roiCalculation.rawPriceIncrease)} 
                                    <span className="text-sm ml-1">({formatPercent(analysisResult.roiCalculation.rawPriceIncreasePercent)})</span>
                                  </span>
                                </div>
                                <div className="flex justify-between items-center py-1 border-b border-blue-100">
                                  <span className="text-gray-600">
                                    Natural Market Appreciation ({analysisResult.roiCalculation.naturalAppreciation?.region || 'NATIONAL'}):
                                  </span>
                                  <span className="font-bold text-amber-600">
                                    -{formatCurrency(analysisResult.roiCalculation.naturalAppreciation?.amount || 0)}
                                    <span className="text-sm ml-1">({formatPercent(analysisResult.roiCalculation.naturalAppreciation?.percent || 0)})</span>
                                  </span>
                                </div>
                                <div className="flex justify-between items-center py-2 bg-purple-100 rounded px-2 mt-2">
                                  <span className="font-semibold text-purple-800">🎯 Renovation-Attributed Value:</span>
                                  <span className={`font-bold text-xl ${analysisResult.roiCalculation.renovationAttributedValue >= 0 ? 'text-purple-700' : 'text-red-600'}`}>
                                    {formatCurrency(analysisResult.roiCalculation.renovationAttributedValue)}
                                  </span>
                                </div>
                                <p className="text-xs text-gray-500 italic mt-1">
                                  This is the TRUE value added by renovations after removing natural market appreciation.
                                </p>
                              </div>
                            </div>

                            {/* ROI Metrics */}
                            <div className="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-lg p-4">
                              <h5 className="font-bold text-green-700 mb-3">💰 ROI Analysis</h5>
                              <div className="grid grid-cols-2 gap-4 text-sm">
                                <div className="bg-white rounded-lg p-3 border">
                                  <span className="text-gray-500 block text-xs">Est. Renovation Cost</span>
                                  <span className="font-bold text-xl">{formatCurrency(analysisResult.roiCalculation.totalEstimatedCost)}</span>
                                </div>
                                <div className="bg-white rounded-lg p-3 border">
                                  <span className="text-gray-500 block text-xs">Net Profit</span>
                                  <span className={`font-bold text-xl ${analysisResult.roiCalculation.netProfit >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {formatCurrency(analysisResult.roiCalculation.netProfit)}
                                  </span>
                                </div>
                                <div className="bg-white rounded-lg p-3 border">
                                  <span className="text-gray-500 block text-xs">TRUE Value ROI</span>
                                  <span className={`font-bold text-2xl ${(analysisResult.roiCalculation.valueROI || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {analysisResult.roiCalculation.valueROI !== null ? formatPercent(analysisResult.roiCalculation.valueROI) : 'N/A'}
                                  </span>
                                </div>
                                <div className="bg-white rounded-lg p-3 border">
                                  <span className="text-gray-500 block text-xs">Simple ROI (no appreciation adj.)</span>
                                  <span className={`font-bold text-lg text-gray-500`}>
                                    {formatPercent(analysisResult.roiCalculation.simpleROI)}
                                  </span>
                                </div>
                                <div className="col-span-2 flex justify-between items-center bg-white rounded-lg p-3 border">
                                  <div>
                                    <span className="text-gray-500 block text-xs">Annualized Value ROI</span>
                                    <span className={`font-bold text-lg ${(analysisResult.roiCalculation.annualizedValueROI || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                      {analysisResult.roiCalculation.annualizedValueROI !== null ? formatPercent(analysisResult.roiCalculation.annualizedValueROI) : 'N/A'}
                                    </span>
                                  </div>
                                  <div className="text-right">
                                    <span className="text-gray-500 block text-xs">Holding Period</span>
                                    <span className="font-bold text-lg">{analysisResult.roiCalculation.holdingMonths} months</span>
                                  </div>
                                </div>
                              </div>
                              
                              {/* Verdict Badge */}
                              <div className="mt-4 text-center">
                                <span className={`inline-block px-6 py-2 rounded-full font-bold text-lg ${
                                  analysisResult.roiCalculation.profitability === 'profitable' ? 'bg-green-500 text-white' :
                                  analysisResult.roiCalculation.profitability === 'break-even' ? 'bg-yellow-400 text-gray-800' : 'bg-red-500 text-white'
                                }`}>
                                  {analysisResult.roiCalculation.profitability === 'profitable' ? '✅ PROFITABLE' :
                                   analysisResult.roiCalculation.profitability === 'break-even' ? '⚖️ BREAK-EVEN' : '❌ LOSS'}
                                </span>
                              </div>
                            </div>

                            {/* Best Bang for Buck Rankings */}
                            {analysisResult.roiCalculation.renovationRankings?.length > 0 && (
                              <div className="bg-gradient-to-r from-amber-50 to-yellow-50 border border-amber-200 rounded-lg p-4">
                                <h5 className="font-bold text-amber-700 mb-3">🏆 Best Bang for Buck Rankings</h5>
                                <div className="space-y-2">
                                  {analysisResult.roiCalculation.renovationRankings.map((r, idx) => (
                                    <div key={idx} className="flex items-center justify-between bg-white rounded p-2 border">
                                      <div className="flex items-center gap-3">
                                        <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
                                          idx === 0 ? 'bg-yellow-400 text-yellow-900' :
                                          idx === 1 ? 'bg-gray-300 text-gray-700' :
                                          idx === 2 ? 'bg-orange-300 text-orange-800' : 'bg-gray-100 text-gray-600'
                                        }`}>
                                          {idx + 1}
                                        </span>
                                        <div>
                                          <span className="font-medium text-gray-800">{r.category.replace(/_/g, ' ').toUpperCase()}</span>
                                          <span className="text-xs text-gray-500 ml-2">({r.scope})</span>
                                        </div>
                                      </div>
                                      <div className="text-right">
                                        <span className={`font-bold ${
                                          r.ranking === 'excellent' ? 'text-green-600' :
                                          r.ranking === 'good' ? 'text-blue-600' :
                                          r.ranking === 'fair' ? 'text-yellow-600' : 'text-red-600'
                                        }`}>
                                          {r.roi}% ROI
                                        </span>
                                        <span className="text-xs text-gray-500 ml-2">{formatCurrency(r.cost)}</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Market Timing Signals */}
                        {analysisResult.marketTiming && (
                          <div className="bg-gradient-to-r from-sky-50 to-cyan-50 border border-sky-200 rounded-lg p-4">
                            <h5 className="font-bold text-sky-700 mb-3">📈 Market Timing Context</h5>
                            <div className="grid grid-cols-2 gap-3 text-sm">
                              <div className="flex items-center gap-2">
                                <span className={`px-2 py-1 rounded text-xs font-bold ${
                                  analysisResult.marketTiming.marketHeat === 'hot' ? 'bg-red-100 text-red-700' :
                                  analysisResult.marketTiming.marketHeat === 'warm' ? 'bg-orange-100 text-orange-700' :
                                  analysisResult.marketTiming.marketHeat === 'cold' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                                }`}>
                                  {analysisResult.marketTiming.marketHeat?.toUpperCase()} MARKET
                                </span>
                              </div>
                              <div>
                                <span className="text-gray-500">Avg Annual Appreciation:</span>
                                <span className="font-bold ml-2">{formatPercent(analysisResult.marketTiming.avgAnnualAppreciation)}</span>
                              </div>
                              <div className="col-span-2 text-xs text-gray-600 bg-white p-2 rounded">
                                {analysisResult.marketTiming.timing}
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Confidence & Data Quality */}
                        {analysisResult.confidence && (
                          <div className="bg-gradient-to-r from-gray-50 to-slate-50 border border-gray-200 rounded-lg p-4">
                            <h5 className="font-bold text-gray-700 mb-3">📊 Confidence & Data Quality</h5>
                            <div className="flex items-center justify-between mb-3">
                              <div className="flex items-center gap-3">
                                <span className={`px-3 py-1 rounded-full font-bold text-sm ${
                                  analysisResult.confidence.level === 'high' ? 'bg-green-100 text-green-700' :
                                  analysisResult.confidence.level === 'medium' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'
                                }`}>
                                  {analysisResult.confidence.level?.toUpperCase()} CONFIDENCE
                                </span>
                                <span className="text-2xl font-bold text-gray-700">{analysisResult.confidence.score}/100</span>
                              </div>
                              <span className={`px-2 py-1 rounded text-xs font-medium ${
                                analysisResult.confidence.dataQuality === 'verified' ? 'bg-green-100 text-green-700' :
                                analysisResult.confidence.dataQuality === 'estimated' ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'
                              }`}>
                                {analysisResult.confidence.dataQuality}
                              </span>
                            </div>
                            {/* Confidence bar */}
                            <div className="w-full bg-gray-200 rounded-full h-3 mb-3">
                              <div 
                                className={`h-3 rounded-full transition-all ${
                                  analysisResult.confidence.score >= 75 ? 'bg-green-500' :
                                  analysisResult.confidence.score >= 45 ? 'bg-yellow-500' : 'bg-red-500'
                                }`}
                                style={{ width: `${analysisResult.confidence.score}%` }}
                              />
                            </div>
                            {/* Tax validation */}
                            {analysisResult.taxValidation && (
                              <div className="text-xs flex items-center gap-2 mb-2">
                                <span className="text-gray-500">Tax Validation:</span>
                                <span className={`px-2 py-0.5 rounded ${
                                  analysisResult.taxValidation.status === 'validated' ? 'bg-green-100 text-green-700' :
                                  analysisResult.taxValidation.status === 'partial' ? 'bg-yellow-100 text-yellow-700' :
                                  analysisResult.taxValidation.status === 'mismatch' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
                                }`}>
                                  {analysisResult.taxValidation.status}
                                </span>
                                <span className="text-gray-400">{analysisResult.taxValidation.message}</span>
                              </div>
                            )}
                            {/* Flags */}
                            {analysisResult.confidence.flags?.length > 0 && (
                              <div className="mt-2">
                                <span className="text-xs text-gray-500 font-semibold">⚠️ Flags:</span>
                                <ul className="mt-1 space-y-1">
                                  {analysisResult.confidence.flags.map((flag, idx) => (
                                    <li key={idx} className="text-xs text-orange-600 bg-orange-50 p-1 rounded">{flag}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Negative Signals */}
                        {analysisResult.negativeSignals?.length > 0 && (
                          <div className="bg-gradient-to-r from-red-50 to-pink-50 border border-red-200 rounded-lg p-4">
                            <h5 className="font-bold text-red-700 mb-3">⚠️ Negative Signal Detection</h5>
                            <div className="space-y-2">
                              {analysisResult.negativeSignals.map((signal, idx) => (
                                <div key={idx} className="flex items-center gap-3 bg-white p-2 rounded border border-red-100">
                                  <span className="text-red-500">⚠️</span>
                                  <div>
                                    <span className="font-medium text-gray-800">{signal.category.replace(/_/g, ' ')}</span>
                                    <p className="text-xs text-red-600">{signal.warning}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Property Stratification Context */}
                        {analysisResult.stratification && (
                          <div className="bg-white border rounded-lg p-4">
                            <h5 className="font-semibold text-gray-700 mb-3">🏠 Property Classification</h5>
                            <div className="flex flex-wrap gap-2">
                              <span className="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-medium">
                                {analysisResult.stratification.priceTier?.replace(/_/g, ' ').toUpperCase()}
                              </span>
                              <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-medium">
                                {analysisResult.stratification.yearBuiltBracket?.replace(/_/g, ' ')}
                              </span>
                              <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium">
                                {analysisResult.stratification.propertyType}
                              </span>
                              <span className="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-xs font-medium">
                                {analysisResult.stratification.state} {analysisResult.stratification.zipCode}
                              </span>
                            </div>
                          </div>
                        )}

                        {/* Notes */}
                        {analysisResult.photoAnalysis?.notes && (
                          <div className="bg-gray-50 border rounded-lg p-3 text-sm text-gray-600">
                            <span className="font-semibold">AI Notes:</span> {analysisResult.photoAnalysis.notes}
                          </div>
                        )}

                        {/* Raw Analysis JSON */}
                        <details className="text-sm">
                          <summary className="cursor-pointer text-purple-600 hover:text-purple-800">View Full Analysis JSON</summary>
                          <pre className="mt-2 bg-gray-900 text-purple-300 p-4 rounded-lg overflow-auto max-h-64 text-xs">
                            {JSON.stringify(analysisResult, null, 2)}
                          </pre>
                        </details>
                      </div>
                    )}

                    {/* Raw JSON */}
                    <details className="text-sm">
                      <summary className="cursor-pointer text-gray-500 hover:text-gray-700">View Raw JSON</summary>
                      <pre className="mt-2 bg-gray-900 text-green-400 p-4 rounded-lg overflow-auto max-h-48 text-xs">
                        {JSON.stringify(selectedCandidate, null, 2)}
                      </pre>
                    </details>
                  </div>
                </div>

                {/* Area Stats Card */}
                {areaStats && (
                  <div className="mt-4 bg-white rounded-xl border p-6">
                    <h3 className="text-lg font-bold text-gray-900 mb-4">📊 Area Statistics for {zipCode}</h3>
                    <pre className="bg-gray-900 text-green-400 p-4 rounded-lg overflow-auto max-h-48 text-xs">
                      {JSON.stringify(areaStats, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Area Summary Card */}
                {areaSummary && (
                  <div className="mt-4 bg-white rounded-xl border p-6">
                    <h3 className="text-lg font-bold text-gray-900 mb-4">📈 Area Summary</h3>
                    <pre className="bg-gray-900 text-green-400 p-4 rounded-lg overflow-auto max-h-48 text-xs">
                      {JSON.stringify(areaSummary, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-3 border-t bg-gray-50 text-xs text-gray-500 flex justify-between items-center">
            <span>Data sourced from Zillow API • {candidates?.length || 0} candidates loaded</span>
            <button
              onClick={onClose}
              className="px-4 py-1.5 bg-gray-200 hover:bg-gray-300 rounded text-gray-700 transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>

      {/* Fullscreen Photo Gallery Modal */}
      {showPhotoGallery && selectedCandidate && (
        <div className="fixed inset-0 z-[60] bg-black/90 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between p-4 bg-black/50">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setActivePhotoSet('before')}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  activePhotoSet === 'before'
                    ? 'bg-red-500 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                🔴 Before ({selectedCandidate?.beforePhotos?.length || 0})
              </button>
              <button
                onClick={() => setActivePhotoSet('after')}
                className={`px-4 py-2 rounded-lg font-medium transition ${
                  activePhotoSet === 'after'
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                🟢 After ({selectedCandidate?.afterPhotos?.length || 0})
              </button>
            </div>
            <div className="text-white font-medium">
              Photo {selectedPhotoIndex + 1} of {(activePhotoSet === 'before' ? selectedCandidate?.beforePhotos : selectedCandidate?.afterPhotos)?.length || 0}
            </div>
            <button
              onClick={() => setShowPhotoGallery(false)}
              className="text-white hover:bg-white/20 rounded-full p-2 transition"
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Main image */}
          <div className="flex-1 flex items-center justify-center p-4 relative">
            {/* Previous button */}
            <button
              onClick={() => setSelectedPhotoIndex(Math.max(0, selectedPhotoIndex - 1))}
              disabled={selectedPhotoIndex === 0}
              className="absolute left-4 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full disabled:opacity-30 transition"
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            {/* Image */}
            <img
              src={(activePhotoSet === 'before' ? selectedCandidate?.beforePhotos : selectedCandidate?.afterPhotos)?.[selectedPhotoIndex] || ''}
              alt={`${activePhotoSet} photo ${selectedPhotoIndex + 1}`}
              className="max-h-full max-w-full object-contain rounded-lg shadow-2xl"
              onError={(e) => {
                (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect fill="%23333" width="400" height="300"/><text x="200" y="150" text-anchor="middle" dy=".35em" font-size="20" fill="%23999">Image failed to load</text></svg>';
              }}
            />

            {/* Next button */}
            <button
              onClick={() => {
                const photos = activePhotoSet === 'before' ? selectedCandidate?.beforePhotos : selectedCandidate?.afterPhotos;
                setSelectedPhotoIndex(Math.min((photos?.length || 1) - 1, selectedPhotoIndex + 1));
              }}
              disabled={selectedPhotoIndex >= ((activePhotoSet === 'before' ? selectedCandidate?.beforePhotos : selectedCandidate?.afterPhotos)?.length || 1) - 1}
              className="absolute right-4 p-3 bg-black/50 hover:bg-black/70 text-white rounded-full disabled:opacity-30 transition"
            >
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>

          {/* Thumbnail strip */}
          <div className="p-4 bg-black/50">
            <div className="flex gap-2 justify-center overflow-x-auto max-w-full">
              {(activePhotoSet === 'before' ? selectedCandidate?.beforePhotos : selectedCandidate?.afterPhotos)?.map((url, idx) => (
                <button
                  key={idx}
                  onClick={() => setSelectedPhotoIndex(idx)}
                  className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition ${
                    idx === selectedPhotoIndex ? 'border-white scale-110' : 'border-transparent opacity-60 hover:opacity-100'
                  }`}
                >
                  <img
                    src={url}
                    alt={`Thumbnail ${idx + 1}`}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RenovationROITestModal;
