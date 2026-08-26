/**
 * Photogrammetry View Page
 * 
 * Displays a completed photogrammetry scan with:
 * - 3D mesh viewer
 * - Navigation between viewpoints
 * - Room dimensions
 * - Export options
 * - AI-powered renovation detection
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import PhotogrammetryViewer from '../components/PhotogrammetryViewer';
import Model3DViewer from '../components/Model3DViewer';
import type { NavigationGraph } from '../types/photogrammetry';
import type { 
  RenovationDetectionState,
  ScanMetadata 
} from '../types/renovationDetection';
import { createInitialDetectionState } from '../types/renovationDetection';
import { detectRenovationsFromScan } from '../services/aiRenovationDetectionService';
import type { RefGaussianArtifacts, RefGaussianMeshHybridArtifacts } from '../services/refGaussianBundleService';

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

const PhotogrammetryViewPage: React.FC = () => {
  const { scanId } = useParams<{ scanId: string }>();
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meshUrl, setMeshUrl] = useState<string | null>(null);
  const [externalViewerUrl, setExternalViewerUrl] = useState<string | null>(null);
  const [externalViewerKind, setExternalViewerKind] = useState<'default' | 'refgaussian'>('default');
  const [refGaussianArtifactsForViewer, setRefGaussianArtifactsForViewer] = useState<RefGaussianArtifacts | null>(null);
  const [refGaussianMeshHybridForViewer, setRefGaussianMeshHybridForViewer] = useState<RefGaussianMeshHybridArtifacts | null>(null);
  const [externalViewerFrameUrl, setExternalViewerFrameUrl] = useState<string | null>(null);
  const [externalViewerOverlayUrls, setExternalViewerOverlayUrls] = useState<string[]>([]);
  const [mtlUrl, setMtlUrl] = useState<string | undefined>(undefined);
  const [textureUrl, setTextureUrl] = useState<string | undefined>(undefined);
  const [fileType, setFileType] = useState<'glb' | 'obj' | 'ply'>('glb');
  const [navigation, setNavigation] = useState<NavigationGraph | null>(null);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [metadata, setMetadata] = useState<any>(null);
  
  // Renovation detection state
  const [renovationState, setRenovationState] = useState<RenovationDetectionState>(
    createInitialDetectionState()
  );
  const [showRenovationMarkers, setShowRenovationMarkers] = useState(true);
  
  // Create scan metadata for renovation detection
  const scanMetadata: ScanMetadata | undefined = metadata ? {
    scanId: scanId || '',
    address: metadata.address || metadata.roomName || 'Unknown Address',
    propertyType: metadata.propertyType || 'residential',
    propertyValue: metadata.propertyValue || 350000,
    monthlyRent: metadata.monthlyRent || 2500,
    yearBuilt: metadata.yearBuilt || 1990,
    squareFootage: metadata.squareFootage || result?.dimensions?.width && result?.dimensions?.length 
      ? Math.round(result.dimensions.width * result.dimensions.length)
      : 1500,
  } : undefined;

  useEffect(() => {
    if (!scanId) return;
    
    const loadScan = async () => {
      try {
        setLoading(true);
        
        // Try loading from room-scanner API first
        // Check both with and without 'photogrammetry_' prefix
        const roomScannerIds = scanId.startsWith('photogrammetry_') || scanId.startsWith('master_')
          ? [scanId]
          : [`photogrammetry_${scanId}`, scanId];
        
        for (const tryId of roomScannerIds) {
          console.log('[PhotogrammetryView] Trying room-scanner ID:', tryId);
          
          try {
            const scanResponse = await fetch(`/api/room-scanner/scans/${tryId}`);
            if (!scanResponse.ok) continue;
            
            const scanData = await scanResponse.json();
            if (!scanData.success || !scanData.scan) continue;
            
            const scan = scanData.scan;
            console.log('[PhotogrammetryView] Loaded from room-scanner:', tryId);
          
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

          setExternalViewerOverlayUrls([]);
          setExternalViewerFrameUrl(null);
          setExternalViewerKind('default');
          setRefGaussianArtifactsForViewer(null);
          setRefGaussianMeshHybridForViewer(null);

          const resolveMeshHybridArtifacts = (scanIdForUrl: string, metadata: any): RefGaussianMeshHybridArtifacts | null => {
            const hybrid = metadata?.refGaussianMeshHybridArtifacts;
            const modelFiles = metadata?.modelFiles;
            const baseUrl = `/api/room-scanner/scans/${scanIdForUrl}/model`;
            const objUrl = hybrid?.texturedObjUrl
              || (modelFiles?.obj ? `${baseUrl}/${modelFiles.obj.split('/').pop()}` : null);
            if (!objUrl) {
              return null;
            }
            return {
              summaryUrl: hybrid?.summaryUrl,
              texturedObjUrl: objUrl,
              mtlUrl: hybrid?.mtlUrl || (modelFiles?.mtl ? `${baseUrl}/${modelFiles.mtl.split('/').pop()}` : undefined),
              textureUrl: hybrid?.textureUrl || (modelFiles?.texture ? `${baseUrl}/${modelFiles.texture.split('/').pop()}` : undefined),
              numVertices: hybrid?.numVertices ?? metadata?.processingResult?.numVertices,
              numFaces: hybrid?.numFaces ?? metadata?.processingResult?.numFaces,
              pointCount: hybrid?.pointCount,
              method: hybrid?.method,
            };
          };

          const refGaussianArtifacts = scan.metadata?.refGaussianArtifacts || scan.metadata?.gaussianArtifacts?.refGaussian;
          const preferredGaussianBackend = String(
            scan.metadata?.preferredGaussianBackend || scan.metadata?.gaussianBackend || ''
          ).toLowerCase();
          const shouldUseRefGaussian = scan.metadata?.primaryOutput === 'ref_gaussian_splats'
            || preferredGaussianBackend === 'ref_gaussian'
            || preferredGaussianBackend === 'refgaussian';
          if (shouldUseRefGaussian && refGaussianArtifacts) {
            const refGaussianSplatUrl = refGaussianArtifacts.splatUrl;
            const refGaussianViewerUrl = refGaussianArtifacts.viewerUrl;
            const refGaussianPlyUrl = refGaussianArtifacts.plyUrl;
            const refGaussianBundleJsonUrl = refGaussianArtifacts.bundleJsonUrl;
            // viewerUrl is the native render *gallery* (static camera frames), not an
            // interactive 3D viewer. Prefer .splat for in-app orbiting, but pass
            // all artifacts so the product viewer can expose explicit tabs.
            const refGaussianUrl = [refGaussianSplatUrl, refGaussianPlyUrl, refGaussianViewerUrl, refGaussianBundleJsonUrl]
              .find((url) => typeof url === 'string' && url.trim());
            if (typeof refGaussianUrl === 'string' && refGaussianUrl.trim()) {
              console.log('[PhotogrammetryView] Using RefGaussian viewer:', refGaussianUrl);
              setExternalViewerKind('refgaussian');
              setExternalViewerFrameUrl(null);
              setRefGaussianArtifactsForViewer(refGaussianArtifacts);
              setRefGaussianMeshHybridForViewer(resolveMeshHybridArtifacts(tryId, scan.metadata));
              setExternalViewerUrl(refGaussianUrl);
              setLoading(false);
              return;
            }
          }

          const scaffoldGsArtifacts = scan.metadata?.scaffoldGsArtifacts || scan.metadata?.gaussianArtifacts?.scaffoldGs;
          const shouldUseScaffoldGs = scan.metadata?.primaryOutput === 'scaffold_gs_splats'
            || preferredGaussianBackend === 'scaffold_gs'
            || preferredGaussianBackend === 'scaffold-gs'
            || preferredGaussianBackend === 'scaffoldgs';
          if (shouldUseScaffoldGs && scaffoldGsArtifacts) {
            const scaffoldGsUsesConvertedFallback = scaffoldGsArtifacts.renderMode === 'converted_splat_fallback';
            const scaffoldGsUsesExplicitExport = scaffoldGsArtifacts.renderMode === 'explicit_gaussian_export';
            const scaffoldGsUrlCandidates = scaffoldGsUsesConvertedFallback
              ? [
                  scaffoldGsArtifacts.plyUrl,
                  scaffoldGsArtifacts.splatUrl,
                  scaffoldGsArtifacts.viewerUrl,
                ]
              : (scaffoldGsUsesExplicitExport
                  ? [
                      scaffoldGsArtifacts.splatUrl,
                      scaffoldGsArtifacts.plyUrl,
                      scaffoldGsArtifacts.viewerUrl,
                    ]
                  : [
                      scaffoldGsArtifacts.viewerUrl,
                      scaffoldGsArtifacts.splatUrl,
                      scaffoldGsArtifacts.plyUrl,
                    ]);
            const scaffoldGsUrl = scaffoldGsUrlCandidates.find((url) => typeof url === 'string' && url.trim());
            if (typeof scaffoldGsUrl === 'string' && scaffoldGsUrl.trim()) {
              console.log('[PhotogrammetryView] Using Scaffold-GS viewer:', scaffoldGsUrl);
              setExternalViewerKind('default');
              setExternalViewerFrameUrl(scaffoldGsUsesExplicitExport ? (scaffoldGsArtifacts.plyUrl || null) : null);
              setExternalViewerUrl(scaffoldGsUrl);
              setLoading(false);
              return;
            }
          }

          const gaussianViewerUrl = scan.metadata?.gaussianArtifacts?.viewerUrl;
          const gaussianSplatUrl = scan.metadata?.gaussianArtifacts?.splatUrl;
          if (typeof gaussianSplatUrl === 'string' && gaussianSplatUrl.trim()) {
            console.log('[PhotogrammetryView] Using in-app gaussian splat:', gaussianSplatUrl);
            setExternalViewerUrl(gaussianSplatUrl);
            setExternalViewerFrameUrl(null);
            setLoading(false);
            return;
          }

          const gaussianPlyUrl = scan.metadata?.gaussianArtifacts?.plyUrl;
          if (typeof gaussianPlyUrl === 'string' && gaussianPlyUrl.trim()) {
            console.log('[PhotogrammetryView] Using in-app gaussian point cloud fallback:', gaussianPlyUrl);
            setExternalViewerUrl(gaussianPlyUrl);
            setExternalViewerFrameUrl(null);
            setLoading(false);
            return;
          }

          if (typeof gaussianViewerUrl === 'string' && gaussianViewerUrl.trim()) {
            console.log('[PhotogrammetryView] Using gaussian artifact viewer:', gaussianViewerUrl);
            setExternalViewerUrl(gaussianViewerUrl);
            setExternalViewerFrameUrl(null);
            setLoading(false);
            return;
          }

          if (scan.metadata?.modelViewerUrl) {
            console.log('[PhotogrammetryView] Using external viewer:', scan.metadata.modelViewerUrl);
            if (typeof scan.metadata.modelViewerUrl === 'string' && scan.metadata.modelViewerUrl.startsWith('/room-tour-view/')) {
              window.location.replace(scan.metadata.modelViewerUrl);
              return;
            }
            setExternalViewerUrl(scan.metadata.modelViewerUrl);
            setExternalViewerFrameUrl(null);
            setLoading(false);
            return;
          }
          
          // Set mesh URL based on available model files
          // Prefer OBJ over GLB because OBJ+MTL handles textures more reliably
          if (scan.metadata?.modelFiles?.obj) {
            // OBJ format with MTL and texture - works best for textured meshes
            const baseUrl = `/api/room-scanner/scans/${tryId}/model`;
            const objUrl = `${baseUrl}/${scan.metadata.modelFiles.obj.split('/').pop()}`;
            console.log('[PhotogrammetryView] Using OBJ:', objUrl);
            setMeshUrl(objUrl);
            if (scan.metadata.modelFiles.mtl) {
              const mtlUrlPath = `${baseUrl}/${scan.metadata.modelFiles.mtl.split('/').pop()}`;
              console.log('[PhotogrammetryView] MTL URL:', mtlUrlPath);
              setMtlUrl(mtlUrlPath);
            }
            if (scan.metadata.modelFiles.texture) {
              const textureUrlPath = `${baseUrl}/${scan.metadata.modelFiles.texture.split('/').pop()}`;
              console.log('[PhotogrammetryView] Texture URL:', textureUrlPath);
              setTextureUrl(textureUrlPath);
            }
            setFileType('obj');
            console.log('[PhotogrammetryView] File type set to OBJ');
          } else if (scan.metadata?.modelFiles?.glb) {
            // GLB format - fallback
            const glbUrl = `/api/room-scanner/scans/${tryId}/model/model.glb`;
            console.log('[PhotogrammetryView] Using GLB:', glbUrl);
            setMeshUrl(glbUrl);
            setFileType('glb');
          } else {
            setError('No 3D model files found for this scan.');
            setLoading(false);
            return;
          }
          
          setLoading(false);
          return;
          } catch (e) {
            // Try next ID
            continue;
          }
        }
        
        // Fallback: load from photogrammetry API
        console.log('[PhotogrammetryView] Loading from photogrammetry API:', scanId);
        
        // Get processing status and result
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
        
        // Set mesh URL
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
  }, [scanId]);

  // Handle renovation analysis
  const handleAnalyzeRenovations = useCallback(async () => {
    if (!scanId || !scanMetadata) return;
    
    setRenovationState(prev => ({
      ...prev,
      isAnalyzing: true,
      error: null,
    }));
    
    try {
      const response = await detectRenovationsFromScan({
        scanId,
        scanMetadata,
        options: {
          minConfidence: 0.6,
          maxRenovations: 10,
          includeMinorImprovements: true,
        },
      });
      
      setRenovationState({
        renovations: response.renovations,
        isAnalyzing: false,
        error: null,
        analysisTimestamp: new Date().toISOString(),
      });
      
      console.log(`[RenovationAnalysis] Detected ${response.renovations.length} renovations`);
    } catch (err) {
      console.error('[RenovationAnalysis] Failed:', err);
      setRenovationState(prev => ({
        ...prev,
        isAnalyzing: false,
        error: err instanceof Error ? err.message : 'Analysis failed',
      }));
    }
  }, [scanId, scanMetadata]);

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="text-white text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
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
            onClick={() => navigate('/room-scanner')}
            className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
          >
            Back to Scans
          </button>
        </div>
      </div>
    );
  }

  if (externalViewerUrl) {
    return (
      <Model3DViewer
        modelUrl={externalViewerUrl}
        framingPlyUrl={externalViewerFrameUrl || undefined}
        viewerKind={externalViewerKind}
        refGaussianArtifacts={refGaussianArtifactsForViewer}
        refGaussianMeshHybridArtifacts={refGaussianMeshHybridForViewer}
        overlayUrls={externalViewerOverlayUrls}
        onClose={() => navigate('/room-scanner')}
      />
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
              onClick={() => navigate('/room-scanner')}
              className="p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
            >
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </button>
            <div className="text-white">
              <h1 className="text-lg font-semibold">{metadata?.roomName || 'Room Scan'}</h1>
              {result && (
                <p className="text-sm text-white/70">
                  {result.numVertices.toLocaleString()} vertices • {result.numFaces.toLocaleString()} faces
                </p>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            {/* Export button */}
            <a
              href={meshUrl}
              download={`${metadata?.roomName || 'room'}_model.${fileType}`}
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
              disabled={renovationState.isAnalyzing}
              className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                renovationState.renovations.length > 0
                  ? 'bg-green-600 hover:bg-green-700 text-white'
                  : renovationState.isAnalyzing
                    ? 'bg-yellow-600 text-white cursor-wait'
                    : 'bg-purple-600 hover:bg-purple-700 text-white'
              }`}
            >
              {renovationState.isAnalyzing ? (
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
                ${renovationState.renovations.reduce((sum, r) => sum + r.roi.estimatedCost, 0).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/70">Potential Value Add:</span>
              <span className="font-medium text-green-400">
                ${renovationState.renovations.reduce((sum, r) => sum + r.roi.valueLift, 0).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-white/70">Avg ROI:</span>
              <span className="font-medium text-blue-400">
                {Math.round(
                  renovationState.renovations.reduce((sum, r) => sum + r.roi.roi, 0) / 
                  renovationState.renovations.length
                )}%
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
        onClose={() => navigate('/room-scanner')}
        // Renovation detection props
        renovationDetectionState={renovationState}
        scanMetadata={scanMetadata}
        showRenovationMarkers={showRenovationMarkers}
      />
    </div>
  );
};

export default PhotogrammetryViewPage;
