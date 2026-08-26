/**
 * Renovation Scan Results Page
 * 
 * Displays comprehensive results from a Live Renovation Assessment scan.
 * Shows:
 * - Room measurements
 * - Renovation recommendations with costs
 * - ROI projections
 * - Quick wins vs major projects
 * - AI-generated renovation previews
 */

import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  ArrowLeft,
  Home,
  Ruler,
  DollarSign,
  TrendingUp,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Wrench,
  Paintbrush,
  Hammer,
  Zap,
} from 'lucide-react';

// Types
interface RenovationResult {
  id: string;
  type: string;
  category: string;
  description: string;
  currentCondition: string;
  recommendation: string;
  priority: number;
  impact: 'low' | 'medium' | 'high' | 'transformative';
  materials: {
    primary: string;
    quantity: string;
    alternatives: string[];
  };
  quantities?: Record<string, { quantity: number; unit: string }>;
  costEstimate?: {
    materials: number;
    labor: number;
    total: number;
    range: { low: number; high: number };
  };
  roi?: {
    estimatedValueIncrease: number;
    roi: number;
    paybackMonths: number | null;
    monthlyRentIncrease: number | null;
  };
  previewImage?: string;
}

interface ScanResults {
  sessionId: string;
  roomName: string;
  roomType: string;
  captureCount: number;
  measurements: {
    room: {
      length: number;
      width: number;
      height: number;
      unit: string;
      confidence: number;
    } | null;
    objects: Array<{
      objectType: string;
      dimensions: { width: number; height: number; depth: number };
      confidence: number;
    }>;
  };
  assessment: {
    overallCondition: string;
    cleanlinessScore: number;
    modernityScore: number;
    maintenanceNeeds: string[];
  };
  renovations: RenovationResult[];
  quickWins: string[];
  majorProjects: string[];
  totalEstimate: {
    low: number;
    high: number;
    recommended: number;
  };
  generatedAt: string;
}

const RenovationScanResultsPage: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const session = location.state?.session;
  
  const [results, setResults] = useState<ScanResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRenovation, setExpandedRenovation] = useState<string | null>(null);
  const [generatingPreview, setGeneratingPreview] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [savedToFirestore, setSavedToFirestore] = useState(false);
  
  // Process the scan session on mount
  useEffect(() => {
    if (!session) {
      setError('No scan session data found');
      setLoading(false);
      return;
    }
    
    processSession();
  }, [session]);
  
  const processSession = async () => {
    try {
      setLoading(true);
      
      const response = await fetch('/api/renovation/assess-from-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session,
          propertyId: session.propertyId,
          address: session.address,
          zipCode: session.zipCode || '90210', // Use session zip code or fallback
        }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to process scan');
      }
      
      const data = await response.json();
      setResults(data);
    } catch (err: any) {
      setError(err.message || 'Failed to analyze scan');
    } finally {
      setLoading(false);
    }
  };
  
  const generatePreview = async (renovation: RenovationResult) => {
    setGeneratingPreview(renovation.id);
    
    try {
      // Find a relevant capture for this renovation
      const relevantCapture = session.captures.find((c: any) => 
        c.tag === renovation.category || c.tag === 'general'
      ) || session.captures[0];
      
      const response = await fetch('/api/renovation-preview/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: relevantCapture.imageData,
          renovationType: renovation.type,
          description: renovation.recommendation,
          measurements: results?.measurements,
        }),
      });
      
      if (response.ok) {
        const data = await response.json();
        // Update renovation with preview (server returns imageUrl or generatedImageUrl)
        const previewImage = data.imageUrl || data.generatedImageUrl || data.previewUrl;
        setResults(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            renovations: prev.renovations.map(r => 
              r.id === renovation.id ? { ...r, previewImage } : r
            ),
          };
        });
      }
    } catch (err) {
      console.error('Failed to generate preview:', err);
    } finally {
      setGeneratingPreview(null);
    }
  };
  
  // Save renovation results to backend/Firestore for the Suggested Renovations page
  const saveToRenovations = async () => {
    if (!results || savedToFirestore) return;
    
    setIsSaving(true);
    try {
      const response = await fetch('/api/renovation/save-scan-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: results.sessionId,
          roomName: results.roomName,
          roomType: results.roomType,
          address: session?.address,
          zipCode: session?.zipCode,
          propertyId: session?.propertyId,
          measurements: results.measurements,
          assessment: results.assessment,
          renovations: results.renovations,
          quickWins: results.quickWins,
          majorProjects: results.majorProjects,
          totalEstimate: results.totalEstimate,
          captureCount: results.captureCount,
          // Include a thumbnail from the first capture
          thumbnailImage: session?.captures?.[0]?.imageData?.slice(0, 1000), // Truncated for storage
        }),
      });
      
      if (response.ok) {
        setSavedToFirestore(true);
      } else {
        console.error('Failed to save renovation results');
      }
    } catch (err) {
      console.error('Error saving renovation results:', err);
    } finally {
      setIsSaving(false);
    }
  };
  
  // Navigate to the full renovations page
  const viewAllRenovations = async () => {
    await saveToRenovations();
    navigate('/renovations');
  };
  
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };
  
  const formatMeasurement = (meters: number) => {
    const feet = meters * 3.28084;
    const wholeFeet = Math.floor(feet);
    const inches = Math.round((feet - wholeFeet) * 12);
    return inches > 0 ? `${wholeFeet}' ${inches}"` : `${wholeFeet}'`;
  };
  
  const getPriorityColor = (priority: number) => {
    if (priority <= 2) return 'bg-red-100 text-red-800';
    if (priority <= 3) return 'bg-yellow-100 text-yellow-800';
    return 'bg-green-100 text-green-800';
  };
  
  const getImpactColor = (impact: string) => {
    switch (impact) {
      case 'transformative': return 'text-purple-600';
      case 'high': return 'text-green-600';
      case 'medium': return 'text-blue-600';
      default: return 'text-gray-600';
    }
  };
  
  const getCategoryIcon = (category: string) => {
    switch (category) {
      case 'kitchen': return <Wrench className="w-5 h-5" />;
      case 'bathroom': return <Wrench className="w-5 h-5" />;
      case 'flooring': return <Hammer className="w-5 h-5" />;
      case 'paint': return <Paintbrush className="w-5 h-5" />;
      case 'electrical': return <Zap className="w-5 h-5" />;
      default: return <Hammer className="w-5 h-5" />;
    }
  };
  
  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900">Analyzing Your Scan</h2>
          <p className="text-gray-500 mt-2">Processing {session?.captures?.length || 0} captures...</p>
        </div>
      </div>
    );
  }
  
  // Error state
  if (error || !results) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="text-center max-w-md">
          <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-gray-900">Analysis Failed</h2>
          <p className="text-gray-500 mt-2">{error || 'Unknown error occurred'}</p>
          <button
            onClick={() => navigate(-1)}
            className="mt-6 px-6 py-3 bg-purple-600 text-white rounded-lg font-medium"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      {/* Header */}
      <div className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <button
              onClick={() => navigate(-1)}
              className="p-2 -ml-2 text-gray-600 hover:text-gray-900"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold text-gray-900">Renovation Analysis</h1>
            <div className="w-10" />
          </div>
        </div>
      </div>
      
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Room Summary Card */}
        <div className="bg-white rounded-2xl shadow-sm p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center">
              <Home className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">{results.roomName}</h2>
              <p className="text-gray-500 capitalize">{results.roomType?.replace('_', ' ')}</p>
            </div>
          </div>
          
          {/* Measurements */}
          {results.measurements.room && (
            <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t">
              <div className="text-center">
                <Ruler className="w-5 h-5 text-gray-400 mx-auto mb-1" />
                <p className="text-lg font-semibold text-gray-900">
                  {formatMeasurement(results.measurements.room.length)}
                </p>
                <p className="text-xs text-gray-500">Length</p>
              </div>
              <div className="text-center">
                <Ruler className="w-5 h-5 text-gray-400 mx-auto mb-1" />
                <p className="text-lg font-semibold text-gray-900">
                  {formatMeasurement(results.measurements.room.width)}
                </p>
                <p className="text-xs text-gray-500">Width</p>
              </div>
              <div className="text-center">
                <Ruler className="w-5 h-5 text-gray-400 mx-auto mb-1" />
                <p className="text-lg font-semibold text-gray-900">
                  {formatMeasurement(results.measurements.room.height)}
                </p>
                <p className="text-xs text-gray-500">Height</p>
              </div>
            </div>
          )}
          
          {/* Room Condition */}
          <div className="flex items-center gap-4 mt-4 pt-4 border-t">
            <div className="flex-1">
              <p className="text-sm text-gray-500">Condition</p>
              <p className="font-medium capitalize text-gray-900">
                {results.assessment.overallCondition}
              </p>
            </div>
            <div className="flex-1">
              <p className="text-sm text-gray-500">Modernity</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-purple-500"
                    style={{ width: `${results.assessment.modernityScore * 10}%` }}
                  />
                </div>
                <span className="text-sm font-medium">{results.assessment.modernityScore}/10</span>
              </div>
            </div>
          </div>
        </div>
        
        {/* Total Estimate Card */}
        <div className="bg-gradient-to-r from-purple-600 to-purple-700 rounded-2xl shadow-lg p-6 text-white">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-5 h-5" />
            <span className="text-purple-200">Total Investment Estimate</span>
          </div>
          <p className="text-3xl font-bold">{formatCurrency(results.totalEstimate.recommended)}</p>
          <p className="text-purple-200 text-sm mt-1">
            Range: {formatCurrency(results.totalEstimate.low)} - {formatCurrency(results.totalEstimate.high)}
          </p>
        </div>
        
        {/* Quick Wins */}
        {results.quickWins.length > 0 && (
          <div className="bg-green-50 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-5 h-5 text-green-600" />
              <h3 className="font-semibold text-green-900">Quick Wins</h3>
            </div>
            <ul className="space-y-2">
              {results.quickWins.map((win, i) => (
                <li key={i} className="flex items-start gap-2 text-green-800">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <span className="text-sm">{win}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        
        {/* Renovations List */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900">Recommended Renovations</h3>
          
          {results.renovations.map((renovation) => (
            <div 
              key={renovation.id}
              className="bg-white rounded-2xl shadow-sm overflow-hidden"
            >
              {/* Main content */}
              <div 
                className="p-5 cursor-pointer"
                onClick={() => setExpandedRenovation(
                  expandedRenovation === renovation.id ? null : renovation.id
                )}
              >
                <div className="flex items-start gap-4">
                  {/* Category icon */}
                  <div className="w-10 h-10 bg-gray-100 rounded-lg flex items-center justify-center text-gray-600 flex-shrink-0">
                    {getCategoryIcon(renovation.category)}
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-semibold text-gray-900">{renovation.type}</h4>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getPriorityColor(renovation.priority)}`}>
                        Priority {renovation.priority}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600 line-clamp-2">{renovation.description}</p>
                    
                    {/* Cost and impact */}
                    <div className="flex items-center gap-4 mt-3">
                      {renovation.costEstimate && (
                        <span className="text-lg font-bold text-gray-900">
                          {formatCurrency(renovation.costEstimate.total)}
                        </span>
                      )}
                      <span className={`text-sm font-medium ${getImpactColor(renovation.impact)}`}>
                        {renovation.impact} impact
                      </span>
                    </div>
                  </div>
                  
                  {/* Expand/collapse */}
                  {expandedRenovation === renovation.id ? (
                    <ChevronUp className="w-5 h-5 text-gray-400 flex-shrink-0" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-gray-400 flex-shrink-0" />
                  )}
                </div>
              </div>
              
              {/* Expanded details */}
              {expandedRenovation === renovation.id && (
                <div className="px-5 pb-5 pt-0 border-t">
                  <div className="pt-4 space-y-4">
                    {/* Current condition */}
                    <div>
                      <p className="text-sm font-medium text-gray-500 mb-1">Current Condition</p>
                      <p className="text-gray-700">{renovation.currentCondition}</p>
                    </div>
                    
                    {/* Recommendation */}
                    <div>
                      <p className="text-sm font-medium text-gray-500 mb-1">Recommendation</p>
                      <p className="text-gray-700">{renovation.recommendation}</p>
                    </div>
                    
                    {/* Materials */}
                    <div>
                      <p className="text-sm font-medium text-gray-500 mb-1">Materials</p>
                      <p className="text-gray-700">
                        {renovation.materials.primary} - {renovation.materials.quantity}
                      </p>
                      {renovation.materials.alternatives?.length > 0 && (
                        <p className="text-sm text-gray-500 mt-1">
                          Alternatives: {renovation.materials.alternatives.join(', ')}
                        </p>
                      )}
                    </div>
                    
                    {/* Cost breakdown */}
                    {renovation.costEstimate && (
                      <div className="grid grid-cols-3 gap-4 bg-gray-50 rounded-lg p-3">
                        <div>
                          <p className="text-xs text-gray-500">Materials</p>
                          <p className="font-semibold">{formatCurrency(renovation.costEstimate.materials)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500">Labor</p>
                          <p className="font-semibold">{formatCurrency(renovation.costEstimate.labor)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-500">Total</p>
                          <p className="font-semibold text-purple-600">{formatCurrency(renovation.costEstimate.total)}</p>
                        </div>
                      </div>
                    )}
                    
                    {/* ROI */}
                    {renovation.roi && (
                      <div className="bg-green-50 rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-2">
                          <TrendingUp className="w-4 h-4 text-green-600" />
                          <span className="text-sm font-medium text-green-800">Return on Investment</span>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs text-green-600">Est. Value Increase</p>
                            <p className="font-semibold text-green-800">
                              {formatCurrency(renovation.roi.estimatedValueIncrease)}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-green-600">ROI</p>
                            <p className="font-semibold text-green-800">{renovation.roi.roi}%</p>
                          </div>
                          {renovation.roi.monthlyRentIncrease && (
                            <>
                              <div>
                                <p className="text-xs text-green-600">Rent Increase</p>
                                <p className="font-semibold text-green-800">
                                  +{formatCurrency(renovation.roi.monthlyRentIncrease)}/mo
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-green-600">Payback Period</p>
                                <p className="font-semibold text-green-800">
                                  {renovation.roi.paybackMonths} months
                                </p>
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {/* Preview button */}
                    <div className="pt-2">
                      {renovation.previewImage ? (
                        <div className="rounded-lg overflow-hidden">
                          <img 
                            src={renovation.previewImage} 
                            alt="Renovation preview"
                            className="w-full h-48 object-cover"
                          />
                        </div>
                      ) : (
                        <button
                          onClick={() => generatePreview(renovation)}
                          disabled={generatingPreview === renovation.id}
                          className="w-full py-3 bg-purple-100 text-purple-700 rounded-lg font-medium flex items-center justify-center gap-2 hover:bg-purple-200 disabled:opacity-50"
                        >
                          {generatingPreview === renovation.id ? (
                            <>
                              <Loader2 className="w-5 h-5 animate-spin" />
                              Generating Preview...
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-5 h-5" />
                              Generate AI Preview
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
        
        {/* Major Projects Section */}
        {results.majorProjects.length > 0 && (
          <div className="bg-blue-50 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-3">
              <Hammer className="w-5 h-5 text-blue-600" />
              <h3 className="font-semibold text-blue-900">Major Projects for Maximum Value</h3>
            </div>
            <ul className="space-y-2">
              {results.majorProjects.map((project, i) => (
                <li key={i} className="flex items-start gap-2 text-blue-800">
                  <span className="w-5 h-5 bg-blue-200 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm">{project}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        
        {/* Save & View All Renovations Button */}
        <div className="bg-white rounded-2xl shadow-sm p-6">
          <button
            onClick={viewAllRenovations}
            disabled={isSaving}
            className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-xl font-bold text-lg flex items-center justify-center gap-2 hover:from-purple-700 hover:to-indigo-700 disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                Saving...
              </>
            ) : savedToFirestore ? (
              <>
                <CheckCircle2 className="w-5 h-5" />
                View All My Renovations
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5" />
                Save & View All Renovations
              </>
            )}
          </button>
          <p className="text-center text-gray-500 text-sm mt-2">
            Save these findings to your Suggested Renovations dashboard
          </p>
        </div>
      </div>
    </div>
  );
};

export default RenovationScanResultsPage;
