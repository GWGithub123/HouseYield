/**
 * Contractor Scan View Page
 * 
 * Full-featured photogrammetry scan viewer for contractors in the marketplace.
 * Allows contractors to view 3D scans with all measurement and visualization tools
 * before submitting bids on renovation projects.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import PhotogrammetryViewer from '../components/PhotogrammetryViewer';
import type { NavigationGraph } from '../types/photogrammetry';
import type { 
  RenovationDetectionState
} from '../types/renovationDetection';
import { createInitialDetectionState } from '../types/renovationDetection';
import { detectRenovationsFromScan } from '../services/aiRenovationDetectionService';

interface ProcessingResult {
  success: boolean;
  totalTime: number;
  numRegistered: number;
  numPoints: number;
  numVertices: number;
  numFaces: number;
  numViewpoints: number;
  dimensions: Record<string, number>;
  error?: string;
}

// Local scan metadata type for the renovation detection
interface ScanMetadataLocal {
  scanId: string;
  address: string;
  propertyType: string;
  propertyValue: number;
  monthlyRent: number;
  yearBuilt: number;
  squareFootage: number;
}

const ContractorScanViewPage: React.FC = () => {
  const { scanId, listingId } = useParams<{ scanId: string; listingId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meshUrl, setMeshUrl] = useState<string | null>(null);
  const [mtlUrl, setMtlUrl] = useState<string | undefined>(undefined);
  const [textureUrl, setTextureUrl] = useState<string | undefined>(undefined);
  const [fileType, setFileType] = useState<'glb' | 'obj'>('glb');
  const [navigation, setNavigation] = useState<NavigationGraph | null>(null);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [metadata, setMetadata] = useState<any>(null);
  
  // Renovation detection state
  const [renovationState, setRenovationState] = useState<RenovationDetectionState>(
    createInitialDetectionState()
  );
  const [showRenovationMarkers, setShowRenovationMarkers] = useState(true);
  
  // Get listing data from URL params
  const listingRenovationType = searchParams.get('renovationType') || '';
  const listingAddress = searchParams.get('address') || '';
  
  // Create scan metadata for renovation detection
  const scanMetadataLocal: ScanMetadataLocal | undefined = metadata ? {
    scanId: scanId || '',
    address: listingAddress || metadata.address || metadata.roomName || 'Unknown Address',
    propertyType: metadata.propertyType || 'residential',
    propertyValue: metadata.propertyValue || 350000,
    monthlyRent: metadata.monthlyRent || 2500,
    yearBuilt: metadata.yearBuilt || 1990,
    squareFootage: metadata.squareFootage || (result?.dimensions?.width && result?.dimensions?.length 
      ? Math.round(result.dimensions.width * result.dimensions.length)
      : 1500),
  } : undefined;

  useEffect(() => {
    if (!scanId) return;
    
    const loadScan = async () => {
      try {
        setLoading(true);
        
        // Check for model files passed in URL params (from marketplace listing)
        const objUrl = searchParams.get('objUrl');
        const mtlUrlParam = searchParams.get('mtlUrl');
        const textureUrlParam = searchParams.get('textureUrl');
        const glbUrl = searchParams.get('glbUrl');
        
        if (objUrl) {
          console.log('[ContractorScanView] Using OBJ from URL params:', objUrl);
          setMeshUrl(objUrl);
          if (mtlUrlParam) setMtlUrl(mtlUrlParam);
          if (textureUrlParam) setTextureUrl(textureUrlParam);
          setFileType('obj');
          setLoading(false);
          return;
        } else if (glbUrl) {
          console.log('[ContractorScanView] Using GLB from URL params:', glbUrl);
          setMeshUrl(glbUrl);
          setFileType('glb');
          setLoading(false);
          return;
        }
        
        // Try loading from room-scanner API
        const roomScannerIds = scanId.startsWith('photogrammetry_') 
          ? [scanId] 
          : [`photogrammetry_${scanId}`, scanId];
        
        for (const tryId of roomScannerIds) {
          console.log('[ContractorScanView] Trying room-scanner ID:', tryId);
          
          try {
            const scanResponse = await fetch(`/api/room-scanner/scans/${tryId}`);
            if (!scanResponse.ok) continue;
            
            const scanData = await scanResponse.json();
            if (!scanData.success || !scanData.scan) continue;
            
            const scan = scanData.scan;
            console.log('[ContractorScanView] Loaded from room-scanner:', tryId);
          
            // Extract processing result from metadata
            if (scan.metadata?.processingResult) {
              setResult({
                success: true,
                totalTime: scan.metadata.processingResult.totalTime || 0,
                numRegistered: scan.frameCount || 0,
                numPoints: scan.metadata.processingResult.numPoints || 0,
                numVertices: scan.metadata.processingResult.numVertices || 0,
                numFaces: scan.metadata.processingResult.numFaces || 0,
                numViewpoints: scan.metadata.processingResult.numViewpoints || 0,
                dimensions: scan.metadata.processingResult.dimensions || {}
              });
            }
            
            setMetadata(scan.metadata);
            
            // Set mesh URL based on available model files
            const baseUrl = `/api/room-scanner/scans/${tryId}/model`;
            
            if (scan.metadata?.modelFiles?.obj) {
              const objPath = `${baseUrl}/${scan.metadata.modelFiles.obj.split('/').pop()}`;
              console.log('[ContractorScanView] Using OBJ:', objPath);
              setMeshUrl(objPath);
              if (scan.metadata.modelFiles.mtl) {
                setMtlUrl(`${baseUrl}/${scan.metadata.modelFiles.mtl.split('/').pop()}`);
              }
              if (scan.metadata.modelFiles.texture) {
                setTextureUrl(`${baseUrl}/${scan.metadata.modelFiles.texture.split('/').pop()}`);
              }
              setFileType('obj');
            } else if (scan.metadata?.modelFiles?.glb) {
              const glbPath = `${baseUrl}/model.glb`;
              console.log('[ContractorScanView] Using GLB:', glbPath);
              setMeshUrl(glbPath);
              setFileType('glb');
            } else {
              setError('No 3D model files found for this scan.');
              setLoading(false);
              return;
            }
            
            setLoading(false);
            return;
          } catch (e) {
            continue;
          }
        }
        
        // Fallback: load from photogrammetry API
        console.log('[ContractorScanView] Loading from photogrammetry API:', scanId);
        
        const statusResponse = await fetch(`/api/photogrammetry/scans/${scanId}/status`);
        if (!statusResponse.ok) {
          throw new Error('Failed to load scan status');
        }
        
        const statusData = await statusResponse.json();
        
        if (!statusData.result?.success) {
          throw new Error('Scan processing not complete or failed');
        }
        
        setResult(statusData.result);
        setMetadata(statusData.metadata);
        setMeshUrl(`/api/photogrammetry/scans/${scanId}/mesh`);
        
        // Load navigation graph
        try {
          const navResponse = await fetch(`/api/photogrammetry/scans/${scanId}/navigation`);
          if (navResponse.ok) {
            const navData = await navResponse.json();
            setNavigation(navData.navigation);
          }
        } catch (e) {
          console.warn('Navigation graph not available:', e);
        }
        
        setLoading(false);
      } catch (err) {
        console.error('Failed to load photogrammetry scan:', err);
        setError(err instanceof Error ? err.message : 'Failed to load scan');
        setLoading(false);
      }
    };
    
    loadScan();
  }, [scanId, searchParams]);

  // Handle renovation analysis
  const handleAnalyzeRenovations = useCallback(async () => {
    if (!scanId) return;
    
    setRenovationState(prev => ({
      ...prev,
      isDetecting: true,
      detectionError: undefined,
    }));
    
    try {
      const response = await detectRenovationsFromScan({
        scanId,
        propertyAddress: listingAddress || undefined,
        propertyValue: scanMetadataLocal?.propertyValue,
        estimatedRent: scanMetadataLocal?.monthlyRent,
        yearBuilt: scanMetadataLocal?.yearBuilt,
        squareFeet: scanMetadataLocal?.squareFootage,
      });
      
      setRenovationState(prev => ({
        ...prev,
        renovations: response.renovations,
        isDetecting: false,
        detectionComplete: true,
        totalEstimatedCost: response.totalEstimatedCost,
        totalValueIncrease: response.totalValueIncrease,
        totalRentIncrease: response.totalRentIncrease,
        overallROI: response.overallROI,
      }));
      
      console.log(`[RenovationAnalysis] Detected ${response.renovations.length} renovations`);
    } catch (err) {
      console.error('[RenovationAnalysis] Failed:', err);
      setRenovationState(prev => ({
        ...prev,
        isDetecting: false,
        detectionError: err instanceof Error ? err.message : 'Analysis failed',
      }));
    }
  }, [scanId, listingAddress, scanMetadataLocal]);

  const handleBack = () => {
    navigate('/contractor/marketplace');
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="text-white text-center">
          <div className="w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p>Loading 3D model...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
          <div className="text-center mb-6">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2">Failed to Load Scan</h2>
            <p className="text-gray-600">{error}</p>
          </div>
          <button
            onClick={handleBack}
            className="w-full py-3 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 transition-colors"
          >
            Back to Marketplace
          </button>
        </div>
      </div>
    );
  }

  if (!meshUrl) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black">
      {/* Header overlay */}
      <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/80 to-transparent p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={handleBack}
              className="p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
            >
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </button>
            <div className="text-white">
              <h1 className="text-lg font-semibold">
                {listingRenovationType || metadata?.roomName || 'Room Scan'}
              </h1>
              {listingAddress && (
                <p className="text-sm text-white/70">{listingAddress}</p>
              )}
              {result && (
                <p className="text-sm text-white/70">
                  {result.numVertices.toLocaleString()} vertices • {result.numFaces.toLocaleString()} faces
                </p>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {/* Bid Button - Prominent for contractors */}
            {listingId && (
              <button
                onClick={() => navigate(`/contractor/marketplace?listingId=${listingId}&showBid=true`)}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Submit Bid
              </button>
            )}
            
            {/* Download button */}
            <a
              href={meshUrl}
              download={`${listingRenovationType || 'room'}_model.${fileType === 'glb' ? 'glb' : 'obj'}`}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3 3m0 0l-3-3m3 3V8" />
              </svg>
              Download {fileType.toUpperCase()}
            </a>
            
            {/* Analyze Renovations Button */}
            <button
              onClick={handleAnalyzeRenovations}
              disabled={renovationState.isDetecting}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                renovationState.renovations.length > 0
                  ? 'bg-green-600 hover:bg-green-700 text-white'
                  : renovationState.isDetecting
                    ? 'bg-yellow-600 text-white cursor-wait'
                    : 'bg-purple-600 hover:bg-purple-700 text-white'
              }`}
            >
              {renovationState.isDetecting ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Analyzing...
                </>
              ) : renovationState.renovations.length > 0 ? (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  {renovationState.renovations.length} Renovations
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                  </svg>
                  Analyze Renovations
                </>
              )}
            </button>
            
            {/* Toggle Renovation Markers */}
            {renovationState.renovations.length > 0 && (
              <button
                onClick={() => setShowRenovationMarkers(!showRenovationMarkers)}
                className={`px-3 py-2 rounded-lg font-medium transition-colors ${
                  showRenovationMarkers
                    ? 'bg-white/20 text-white'
                    : 'bg-white/10 text-white/60'
                }`}
                title={showRenovationMarkers ? 'Hide Markers' : 'Show Markers'}
              >
                {showRenovationMarkers ? '👁️' : '👁️‍🗨️'}
              </button>
            )}
          </div>
        </div>
      </div>
      
      {/* Contractor-specific info panel */}
      <div className="absolute top-20 left-4 z-10 bg-black/80 text-white rounded-xl p-4 backdrop-blur-sm max-w-xs">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xl">📋</span>
          <h3 className="font-semibold">Project Details</h3>
        </div>
        <div className="space-y-2 text-sm">
          {listingRenovationType && (
            <div className="flex justify-between">
              <span className="text-white/70">Project Type:</span>
              <span className="font-medium">{listingRenovationType}</span>
            </div>
          )}
          {listingAddress && (
            <div>
              <span className="text-white/70">Location:</span>
              <p className="font-medium text-xs mt-1">{listingAddress}</p>
            </div>
          )}
        </div>
        <div className="mt-4 pt-4 border-t border-white/20">
          <p className="text-xs text-white/50">
            💡 Use the measurement tools to calculate materials and scope
          </p>
        </div>
      </div>
      
      {/* Stats panel */}
      {result && (
        <div className="absolute bottom-4 left-4 z-10 bg-black/80 text-white rounded-xl p-4 backdrop-blur-sm">
          <h3 className="font-semibold mb-2">Model Statistics</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <span className="text-white/70">Photos:</span>
            <span>{result.numRegistered}</span>
            
            <span className="text-white/70">Points:</span>
            <span>{result.numPoints.toLocaleString()}</span>
            
            <span className="text-white/70">Faces:</span>
            <span>{result.numFaces.toLocaleString()}</span>
            
            <span className="text-white/70">Viewpoints:</span>
            <span>{result.numViewpoints}</span>
            
            {result.dimensions && Object.keys(result.dimensions).length > 0 && (
              <>
                <span className="text-white/70 col-span-2 mt-2 font-medium">Dimensions:</span>
                {Object.entries(result.dimensions).map(([key, value]) => (
                  <React.Fragment key={key}>
                    <span className="text-white/70">{key}:</span>
                    <span>{typeof value === 'number' ? value.toFixed(2) : parseFloat(String(value))?.toFixed(2) || value}m</span>
                  </React.Fragment>
                ))}
              </>
            )}
          </div>
        </div>
      )}
      
      {/* Renovation Summary Panel */}
      {renovationState.renovations.length > 0 && (
        <div className="absolute bottom-4 right-4 z-10 bg-black/80 text-white rounded-xl p-4 backdrop-blur-sm max-w-sm">
          <h3 className="font-semibold mb-2 flex items-center gap-2">
            <span className="text-xl">🔨</span>
            AI Renovation Analysis
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-white/70">Opportunities Found:</span>
              <span className="font-medium">{renovationState.renovations.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/70">Total Est. Cost:</span>
              <span className="font-medium text-yellow-400">
                ${renovationState.totalEstimatedCost.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/70">Potential Value Add:</span>
              <span className="font-medium text-green-400">
                ${renovationState.totalValueIncrease.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/70">Overall ROI:</span>
              <span className="font-medium text-blue-400">
                {Math.round(renovationState.overallROI)}%
              </span>
            </div>
            <p className="text-white/50 text-xs mt-2">
              Click markers in 3D view for details
            </p>
          </div>
        </div>
      )}
      
      {/* 3D Viewer */}
      <PhotogrammetryViewer
        scanId={scanId!}
        meshUrl={meshUrl}
        mtlUrl={mtlUrl}
        textureUrl={textureUrl}
        fileType={fileType}
        navigation={navigation || undefined}
        onClose={handleBack}
        // Renovation detection props
        renovationDetectionState={renovationState}
        showRenovationMarkers={showRenovationMarkers}
      />
    </div>
  );
};

export default ContractorScanViewPage;
