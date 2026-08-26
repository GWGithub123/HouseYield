/**
 * Photogrammetry Scan Page
 * 
 * Main page for photogrammetry room scanning.
 * Provides a complete workflow:
 * 1. Capture photos with guidance
 * 2. Upload and process
 * 3. View 3D result with navigation
 */

import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import PhotogrammetryScanner from './PhotogrammetryScanner';
import type { ScanPurpose } from './PhotogrammetryScanner';
import type { Full3DPipelineVersion } from './PhotogrammetryScanner';
import MasterPipelineProcessingView from './MasterPipelineProcessingView';
import { PhotogrammetryViewer } from './PhotogrammetryViewer';
import type { PhotogrammetryScan, ProcessingProgress, NavigationGraph } from '../types/photogrammetry';
import {
  captureAndProcess,
  getMeshUrl,
  getNavigation,
  listScans,
  type ScanSummary,
} from '../services/photogrammetryService';
import {
  captureAndProcessMasterScan,
  getMasterRoomScanId,
  type MasterReconstructionJob,
} from '../services/masterReconstructionService';
import type { PhotogrammetryStatus } from '../types/photogrammetry';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Map a phase string from progress callback to valid PhotogrammetryStatus
 */
function mapPhaseToStatus(phase: string): PhotogrammetryStatus {
  const phaseMap: Record<string, PhotogrammetryStatus> = {
    'Creating scan...': 'uploading',
    'Uploading photos...': 'uploading',
    'Uploading metadata...': 'uploading',
    'Ready for processing': 'queued',
    'Processing': 'sparse_reconstruction',
    'Extracting features': 'extracting_features',
    'Matching features': 'matching_features',
    'Sparse reconstruction': 'sparse_reconstruction',
    'Dense reconstruction': 'dense_reconstruction',
    'Generating mesh': 'generating_mesh',
    'Texturing': 'texturing',
    'Generating navigation': 'generating_navigation',
    'Complete': 'complete',
    'Failed': 'failed',
  };
  return phaseMap[phase] || 'sparse_reconstruction';
}

// ============================================================================
// Types
// ============================================================================

type PageState = 
  | { phase: 'select' }
  | { phase: 'capture' }
  | { phase: 'processing'; scanId: string; progress: ProcessingProgress | null }
  | { phase: 'master-processing'; jobId: string; job: MasterReconstructionJob | null; uploadPercent: number; uploadMessage: string }
  | { phase: 'viewing'; scanId: string; navigation: NavigationGraph | null }
  | { phase: 'error'; message: string };

interface PhotogrammetryScanPageProps {
  propertyId?: string;
  roomName?: string;
  onComplete?: (scanId: string) => void;
  onBack?: () => void;
  // AI Renovation mode props
  initialPurpose?: ScanPurpose;
  initialPipelineVersion?: Full3DPipelineVersion;
  captureMode?: 'image_sequence' | 'room_tour';
  roomType?: 'kitchen' | 'bathroom' | 'bedroom' | 'living_room' | 'basement' | 'other';
  address?: string;
  zipCode?: string;
}

// ============================================================================
// Scan Selection Component
// ============================================================================

interface ScanSelectionProps {
  onNewScan: () => void;
  onSelectScan: (scanId: string) => void;
}

function ScanSelection({ onNewScan, onSelectScan }: ScanSelectionProps) {
  const [scans, setScans] = useState<ScanSummary[]>([]);
  const [loading, setLoading] = useState(true);
  
  React.useEffect(() => {
    listScans()
      .then(setScans)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);
  
  const completedScans = scans.filter(s => s.status === 'completed');
  
  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <h1 className="text-3xl font-bold mb-6">3D Room Scanner</h1>
      
      {/* New Scan Button */}
      <button
        onClick={onNewScan}
        className="w-full mb-8 p-6 bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors"
      >
        <div className="flex items-center gap-4">
          <div className="text-4xl">📸</div>
          <div className="text-left">
            <h2 className="text-xl font-bold">New 3D Scan</h2>
            <p className="text-blue-200">Capture a room in full 3D</p>
          </div>
        </div>
      </button>
      
      {/* Previous Scans */}
      <h2 className="text-xl font-bold mb-4">Previous Scans</h2>
      
      {loading ? (
        <div className="text-center py-8 text-gray-400">Loading...</div>
      ) : completedScans.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          No completed scans yet
        </div>
      ) : (
        <div className="grid gap-4">
          {completedScans.map(scan => (
            <button
              key={scan.id}
              onClick={() => onSelectScan(scan.id)}
              className="p-4 bg-gray-800 hover:bg-gray-700 rounded-xl transition-colors text-left"
            >
              <div className="flex justify-between items-start">
                <div>
                  <h3 className="font-bold">{scan.roomName}</h3>
                  <p className="text-sm text-gray-400">
                    {scan.totalPhotos} photos • {new Date(scan.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <span className="text-green-400">✓</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Processing Progress Component
// ============================================================================

interface ProcessingViewProps {
  progress: ProcessingProgress | null;
  onCancel: () => void;
}

function ProcessingView({ progress, onCancel }: ProcessingViewProps) {
  const phases = [
    { key: 'extracting_features', label: 'Extracting Features', icon: '🔍' },
    { key: 'matching_features', label: 'Matching Features', icon: '🔗' },
    { key: 'sparse_reconstruction', label: 'Structure from Motion', icon: '📐' },
    { key: 'dense_reconstruction', label: 'Dense Reconstruction', icon: '☁️' },
    { key: 'generating_mesh', label: 'Generating Mesh', icon: '🔷' },
    { key: 'texturing', label: 'Texturing', icon: '🎨' },
    { key: 'generating_navigation', label: 'Creating Navigation', icon: '🧭' },
    { key: 'exporting', label: 'Exporting', icon: '📦' },
  ];
  
  const currentPhaseIndex = progress
    ? phases.findIndex(p => p.key === progress.phase)
    : -1;
  
  return (
    <div className="min-h-screen bg-gray-900 text-white p-6 flex flex-col items-center justify-center">
      <h1 className="text-2xl font-bold mb-8">Processing Your Scan</h1>
      
      {/* Progress bar */}
      <div className="w-full max-w-md mb-8">
        <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-500"
            style={{ width: `${progress?.percent || 0}%` }}
          />
        </div>
        <div className="flex justify-between mt-2 text-sm text-gray-400">
          <span>{progress?.percent || 0}%</span>
          <span>{progress?.message || 'Initializing...'}</span>
        </div>
      </div>
      
      {/* Phase list */}
      <div className="w-full max-w-md space-y-3 mb-8">
        {phases.map((phase, index) => {
          const isActive = index === currentPhaseIndex;
          const isComplete = index < currentPhaseIndex;
          
          return (
            <div
              key={phase.key}
              className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                isActive
                  ? 'bg-blue-900/50 border border-blue-500'
                  : isComplete
                  ? 'bg-gray-800 text-green-400'
                  : 'bg-gray-800/50 text-gray-500'
              }`}
            >
              <span className="text-xl">{phase.icon}</span>
              <span className="flex-1">{phase.label}</span>
              {isComplete && <span>✓</span>}
              {isActive && (
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              )}
            </div>
          );
        })}
      </div>
      
      {/* Cancel button */}
      <button
        onClick={onCancel}
        className="px-6 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

// ============================================================================
// Main Page Component
// ============================================================================

export function PhotogrammetryScanPage({
  propertyId,
  roomName: initialRoomName,
  onComplete,
  onBack: _onBack, // Reserved for back button functionality
  initialPurpose = 'full-3d',
  initialPipelineVersion = 'master_v1',
  captureMode = 'room_tour',
  roomType,
  address,
  zipCode,
}: PhotogrammetryScanPageProps) {
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>({ phase: 'select' });
  const [roomName, setRoomName] = useState(initialRoomName || 'Room Scan');
  const processingSessionRef = useRef(0);
  
  // Handle new scan capture
  const handleCapture = useCallback(async (scan: PhotogrammetryScan) => {
    const processingSessionId = Date.now();
    processingSessionRef.current = processingSessionId;
    const selectedCaptureMode = scan.captureMode || captureMode;

    try {
      if (scan.pipelineVersion === 'master_v1') {
        setState({
          phase: 'master-processing',
          jobId: '',
          job: null,
          uploadPercent: 0,
          uploadMessage: 'Creating master_v1 job...',
        });

        const { job } = await captureAndProcessMasterScan(scan, {
          roomName,
          propertyId,
          captureMode: selectedCaptureMode,
          onUploadProgress: (percent, message) => {
            setState((prev) => {
              if (processingSessionRef.current !== processingSessionId || prev.phase !== 'master-processing') {
                return prev;
              }

              return {
                ...prev,
                uploadPercent: percent,
                uploadMessage: message,
              };
            });
          },
          onJobUpdate: (nextJob) => {
            setState((prev) => {
              if (processingSessionRef.current !== processingSessionId || prev.phase !== 'master-processing') {
                return prev;
              }

              return {
                ...prev,
                jobId: nextJob.id,
                job: nextJob,
              };
            });
          },
        });

        if (processingSessionRef.current !== processingSessionId) {
          return;
        }

        const roomScanId = getMasterRoomScanId(job);
        onComplete?.(roomScanId);
        navigate(`/photogrammetry-view/${roomScanId}`);
        return;
      }

      // Store scanId in a ref to avoid closure issues
      let currentScanId = '';
      
      setState({
        phase: 'processing',
        scanId: '',
        progress: null,
      });
      
      const { scanId, result } = await captureAndProcess(scan, {
        roomName,
        propertyId,
        processingOptions: {
          pipelineVersion: scan.pipelineVersion,
          gpuCount: scan.pipelineVersion === 'hybrid_v1' ? 2 : 1,
          cudaVisibleDevices: scan.pipelineVersion === 'hybrid_v1' ? '0,1' : '0',
        },
        onProgress: (phase, percent, message) => {
          setState(prev => {
            if (processingSessionRef.current !== processingSessionId || prev.phase !== 'processing') return prev;
            // Map phase string to valid PhotogrammetryStatus
            const validPhase = mapPhaseToStatus(phase);
            return {
              phase: 'processing' as const,
              scanId: currentScanId || prev.scanId,
              progress: {
                phase: validPhase,
                percent,
                message: message || phase,
              },
            };
          });
        },
      });
      
      currentScanId = scanId;

      if (processingSessionRef.current !== processingSessionId) {
        return;
      }
      
      if (result.success) {
        // Load navigation and show viewer
        let navigation: NavigationGraph | null = null;
        try {
          navigation = await getNavigation(scanId);
        } catch (e) {
          console.warn('Navigation not available:', e);
        }
        
        setState({
          phase: 'viewing',
          scanId,
          navigation,
        });
        
        onComplete?.(scanId);
      } else {
        setState({
          phase: 'error',
          message: result.error || 'Processing failed',
        });
      }
    } catch (error) {
      console.error('Processing error:', error);
      if (processingSessionRef.current !== processingSessionId) {
        return;
      }
      setState({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [roomName, propertyId, captureMode, onComplete, navigate]);
  
  // Handle selecting existing scan
  const handleSelectScan = useCallback(async (scanId: string) => {
    try {
      let navigation: NavigationGraph | null = null;
      try {
        navigation = await getNavigation(scanId);
      } catch (e) {
        console.warn('Navigation not available:', e);
      }
      
      setState({
        phase: 'viewing',
        scanId,
        navigation,
      });
    } catch (error) {
      console.error('Error loading scan:', error);
      setState({
        phase: 'error',
        message: 'Failed to load scan',
      });
    }
  }, []);
  
  // Handle cancel processing
  const handleCancelProcessing = useCallback(() => {
    processingSessionRef.current += 1;
    setState({ phase: 'select' });
  }, []);
  
  // Render based on state
  switch (state.phase) {
    case 'select':
      return (
        <ScanSelection
          onNewScan={() => setState({ phase: 'capture' })}
          onSelectScan={handleSelectScan}
        />
      );
    
    case 'capture':
      return (
        <div className="min-h-screen bg-gray-900">
          {/* Room name input */}
          <div className="absolute top-4 left-4 right-4 z-10">
            <input
              type="text"
              value={roomName}
              onChange={(e) => setRoomName(e.target.value)}
              placeholder="Room name..."
              className="w-full px-4 py-2 bg-black/50 backdrop-blur rounded-lg text-white placeholder-gray-400 border border-white/20 focus:border-blue-500 focus:outline-none"
            />
          </div>
          
          <PhotogrammetryScanner
            roomName={roomName}
            propertyId={propertyId}
            onComplete={handleCapture}
            onCancel={() => setState({ phase: 'select' })}
            initialPurpose={initialPurpose}
            initialPipelineVersion={initialPipelineVersion}
            initialCaptureMode={captureMode}
            roomType={roomType}
            address={address}
            zipCode={zipCode}
            onRenovationComplete={(session) => {
              console.log('[PhotogrammetryScanPage] AI renovation scan complete:', session);
              navigate('/renovation-results', { state: { session } });
            }}
          />
        </div>
      );
    
    case 'processing':
      return (
        <ProcessingView
          progress={state.progress}
          onCancel={handleCancelProcessing}
        />
      );

    case 'master-processing':
      return (
        <MasterPipelineProcessingView
          job={state.job}
          uploadPercent={state.uploadPercent}
          uploadMessage={state.uploadMessage}
          onBack={handleCancelProcessing}
        />
      );
    
    case 'viewing':
      return (
        <div className="min-h-screen bg-gray-900">
          {/* Header */}
          <div className="absolute top-4 left-4 right-4 z-10 flex justify-between items-center">
            <button
              onClick={() => setState({ phase: 'select' })}
              className="px-4 py-2 bg-black/50 backdrop-blur rounded-lg text-white"
            >
              ← Back
            </button>
            <h1 className="text-white font-bold">{roomName}</h1>
            <div className="w-20" /> {/* Spacer */}
          </div>
          
          {/* 3D Viewer */}
          <PhotogrammetryViewer
            scanId={state.scanId}
            meshUrl={getMeshUrl(state.scanId)}
            navigation={state.navigation || undefined}
            className="w-full h-screen"
          />
        </div>
      );
    
    case 'error':
      return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-6">
          <div className="text-6xl mb-4">❌</div>
          <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
          <p className="text-gray-400 mb-8 text-center">{state.message}</p>
          <button
            onClick={() => setState({ phase: 'select' })}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
          >
            Try Again
          </button>
        </div>
      );
  }
}

export default PhotogrammetryScanPage;
