/**
 * Cubemap Room Scanner
 * 
 * Guided capture of 6 photos to create a cube panorama.
 * Much simpler and more reliable than continuous scanning.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { CubemapFaces } from './CubemapViewer';
import { requestCameraPermission, captureFrameFromVideo } from '../services/roomScannerService';

type FaceDirection = 'front' | 'back' | 'left' | 'right' | 'up' | 'down';

interface CapturedFaces {
  front?: string;
  back?: string;
  left?: string;
  right?: string;
  up?: string;
  down?: string;
}

interface CubemapScannerProps {
  roomName?: string;
  onComplete: (faces: CubemapFaces, roomName: string) => void;
  onCancel: () => void;
}

const FACE_ORDER: FaceDirection[] = ['front', 'right', 'back', 'left', 'up', 'down'];

const FACE_INSTRUCTIONS: Record<FaceDirection, { title: string; instruction: string; icon: string }> = {
  front: {
    title: 'Front Wall',
    instruction: 'Point at the wall in front of you',
    icon: '⬆️'
  },
  right: {
    title: 'Right Wall', 
    instruction: 'Turn 90° right and capture',
    icon: '➡️'
  },
  back: {
    title: 'Back Wall',
    instruction: 'Turn another 90° right (behind you)',
    icon: '⬇️'
  },
  left: {
    title: 'Left Wall',
    instruction: 'Turn 90° right (to your left side)',
    icon: '⬅️'
  },
  up: {
    title: 'Ceiling',
    instruction: 'Point camera up at the ceiling',
    icon: '🔼'
  },
  down: {
    title: 'Floor',
    instruction: 'Point camera down at the floor',
    icon: '🔽'
  }
};

const CubemapScanner: React.FC<CubemapScannerProps> = ({
  roomName = 'Room',
  onComplete,
  onCancel
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  const [isInitialized, setIsInitialized] = useState(false);
  const [currentFaceIndex, setCurrentFaceIndex] = useState(0);
  const [capturedFaces, setCapturedFaces] = useState<CapturedFaces>({});
  const [isCapturing, setIsCapturing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentFace = FACE_ORDER[currentFaceIndex];
  const currentInstruction = FACE_INSTRUCTIONS[currentFace];
  const capturedCount = Object.keys(capturedFaces).length;

  // Initialize camera
  useEffect(() => {
    let mounted = true;
    
    const init = async () => {
      try {
        const stream = await requestCameraPermission();
        if (!mounted) {
          // Component unmounted during permission request
          stream?.getTracks().forEach(track => track.stop());
          return;
        }
        
        if (stream && videoRef.current) {
          streamRef.current = stream;
          videoRef.current.srcObject = stream;
          
          // Safari/iOS requires these attributes to be set before play()
          videoRef.current.setAttribute('playsinline', 'true');
          videoRef.current.setAttribute('webkit-playsinline', 'true');
          videoRef.current.muted = true;
          
          // Wait for video to be ready before playing
          await new Promise<void>((resolve, reject) => {
            const video = videoRef.current!;
            let resolved = false;
            let timeoutId: NodeJS.Timeout;
            
            const cleanup = () => {
              clearTimeout(timeoutId);
              video.onloadedmetadata = null;
            };
            
            video.onloadedmetadata = () => {
              if (resolved) return;
              resolved = true;
              cleanup();
              
              video.play()
                .then(() => resolve())
                .catch((playErr) => {
                  console.warn('[CubemapScanner] Play failed, trying muted:', playErr);
                  // iOS sometimes needs a user gesture - try muted autoplay
                  video.muted = true;
                  video.play()
                    .then(() => resolve())
                    .catch(reject);
                });
            };
            
            // If metadata already loaded (cached), trigger immediately
            if (video.readyState >= 1) {
              video.onloadedmetadata?.(new Event('loadedmetadata'));
            }
            
            // Timeout after 10 seconds (increased from 5)
            timeoutId = setTimeout(() => {
              if (resolved) return;
              resolved = true;
              cleanup();
              reject(new Error('Video load timeout - please try again'));
            }, 10000);
          });
          
          if (mounted) {
            setIsInitialized(true);
          }
        } else {
          if (mounted) {
            setError('Could not access camera. Please check permissions.');
          }
        }
      } catch (err: any) {
        console.error('[CubemapScanner] Camera init error:', err);
        if (mounted) {
          // Show the actual error message
          const message = err?.message || 'Camera permission denied';
          setError(message);
        }
      }
    };
    
    init();
    
    return () => {
      mounted = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Capture current frame
  const capturePhoto = useCallback(() => {
    if (!videoRef.current || isCapturing) return;
    
    setIsCapturing(true);
    
    // Flash effect
    setTimeout(() => {
      const imageData = captureFrameFromVideo(videoRef.current!);
      setPreviewImage(imageData);
      setShowPreview(true);
      setIsCapturing(false);
    }, 100);
  }, [isCapturing]);

  // Accept the captured photo
  const acceptPhoto = useCallback(() => {
    if (!previewImage) return;
    
    setCapturedFaces(prev => ({
      ...prev,
      [currentFace]: previewImage
    }));
    
    setShowPreview(false);
    setPreviewImage(null);
    
    // Move to next face or complete
    if (currentFaceIndex < FACE_ORDER.length - 1) {
      setCurrentFaceIndex(prev => prev + 1);
    }
  }, [previewImage, currentFace, currentFaceIndex]);

  // Retake the photo
  const retakePhoto = useCallback(() => {
    setShowPreview(false);
    setPreviewImage(null);
  }, []);

  // Go back to previous face
  const goBack = useCallback(() => {
    if (currentFaceIndex > 0) {
      const prevFace = FACE_ORDER[currentFaceIndex - 1];
      setCapturedFaces(prev => {
        const newFaces = { ...prev };
        delete newFaces[prevFace];
        return newFaces;
      });
      setCurrentFaceIndex(prev => prev - 1);
    }
  }, [currentFaceIndex]);

  // Complete the scan
  const completeScan = useCallback(() => {
    console.log('[CubemapScanner] completeScan called');
    console.log('[CubemapScanner] capturedFaces:', Object.keys(capturedFaces));
    
    // Check we have all 6 faces
    const allCaptured = FACE_ORDER.every(face => capturedFaces[face]);
    console.log('[CubemapScanner] allCaptured:', allCaptured);
    
    if (!allCaptured) {
      const missing = FACE_ORDER.filter(face => !capturedFaces[face]);
      console.error('[CubemapScanner] Missing faces:', missing);
      setError('Please capture all 6 sides');
      return;
    }
    
    console.log('[CubemapScanner] Calling onComplete...');
    onComplete(capturedFaces as CubemapFaces, roomName);
  }, [capturedFaces, roomName, onComplete]);

  // Check if all faces are captured
  const isComplete = FACE_ORDER.every(face => capturedFaces[face]);

  if (error) {
    return (
      <div className="fixed inset-0 bg-gray-900 flex items-center justify-center z-50">
        <div className="bg-white rounded-2xl p-8 max-w-md mx-4 text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-2">Error</h2>
          <p className="text-gray-600 mb-6">{error}</p>
          <button
            onClick={onCancel}
            className="px-6 py-2 bg-gray-200 rounded-lg font-medium"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black z-50">
      {/* Camera feed */}
      <video
        ref={videoRef}
        playsInline
        // @ts-ignore - Safari iOS specific attribute
        webkit-playsinline="true"
        muted
        autoPlay
        className="absolute inset-0 w-full h-full object-cover"
      />
      
      {/* Capture flash effect */}
      {isCapturing && (
        <div className="absolute inset-0 bg-white animate-pulse z-20" />
      )}
      
      {/* Preview overlay */}
      {showPreview && previewImage && (
        <div className="absolute inset-0 z-30">
          <img 
            src={previewImage} 
            alt="Preview" 
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-black/50" />
          
          {/* Preview controls */}
          <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
            <p className="text-white text-center mb-4 text-lg">
              {currentInstruction.title} - Does this look good?
            </p>
            <div className="flex justify-center gap-4">
              <button
                onClick={retakePhoto}
                className="px-8 py-3 bg-white/20 backdrop-blur-sm rounded-xl text-white font-medium flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Retake
              </button>
              <button
                onClick={acceptPhoto}
                className="px-8 py-3 bg-green-500 rounded-xl text-white font-medium flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Use Photo
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Main UI overlay */}
      {!showPreview && (
        <>
          {/* Top bar */}
          <div className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/80 to-transparent p-4">
            <div className="flex items-center justify-between">
              <button
                onClick={onCancel}
                className="p-2 rounded-full bg-white/20"
              >
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              
              <div className="text-center">
                <p className="text-white/60 text-sm">Step {currentFaceIndex + 1} of 6</p>
                <h2 className="text-white font-semibold">{roomName}</h2>
              </div>
              
              <div className="w-10" />
            </div>
            
            {/* Progress dots */}
            <div className="flex justify-center gap-2 mt-4">
              {FACE_ORDER.map((face, i) => (
                <div
                  key={face}
                  className={`w-3 h-3 rounded-full transition-all ${
                    capturedFaces[face] 
                      ? 'bg-green-500' 
                      : i === currentFaceIndex 
                        ? 'bg-white' 
                        : 'bg-white/30'
                  }`}
                />
              ))}
            </div>
          </div>
          
          {/* Center crosshair/guide */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="relative">
              {/* Corner brackets */}
              <div className="w-48 h-48 relative">
                <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-white/60" />
                <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-white/60" />
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-white/60" />
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-white/60" />
              </div>
            </div>
          </div>
          
          {/* Instruction panel */}
          <div className="absolute left-4 right-4 top-32">
            <div className="bg-black/60 backdrop-blur-sm rounded-2xl p-4 text-center">
              <span className="text-4xl mb-2 block">{currentInstruction.icon}</span>
              <h3 className="text-white text-xl font-bold mb-1">{currentInstruction.title}</h3>
              <p className="text-white/80">{currentInstruction.instruction}</p>
            </div>
          </div>
          
          {/* Thumbnail strip of captured faces */}
          {capturedCount > 0 && (
            <div className="absolute left-4 right-4 bottom-32">
              <div className="flex justify-center gap-2 overflow-x-auto py-2">
                {FACE_ORDER.map((face, i) => (
                  <div
                    key={face}
                    className={`w-12 h-12 rounded-lg overflow-hidden border-2 flex-shrink-0 ${
                      capturedFaces[face] ? 'border-green-500' : 'border-white/30'
                    }`}
                  >
                    {capturedFaces[face] ? (
                      <img 
                        src={capturedFaces[face]} 
                        alt={face}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-white/10 flex items-center justify-center">
                        <span className="text-white/40 text-xs">{i + 1}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {/* Bottom controls */}
          <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black/80 to-transparent">
            <div className="flex items-center justify-center gap-6">
              {/* Back button */}
              <button
                onClick={goBack}
                disabled={currentFaceIndex === 0}
                className={`p-4 rounded-full ${
                  currentFaceIndex === 0 
                    ? 'bg-white/10 text-white/30' 
                    : 'bg-white/20 text-white'
                }`}
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              
              {/* Capture / Complete button */}
              {isComplete ? (
                <button
                  onClick={() => {
                    alert('Complete button clicked! Processing will start...');
                    completeScan();
                  }}
                  className="w-20 h-20 bg-green-500 rounded-full flex items-center justify-center shadow-lg"
                >
                  <svg className="w-10 h-10 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={capturePhoto}
                  disabled={!isInitialized || isCapturing}
                  className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-lg border-4 border-white"
                >
                  <div className={`w-16 h-16 rounded-full ${isCapturing ? 'bg-gray-400' : 'bg-red-500'}`} />
                </button>
              )}
              
              {/* Spacer for alignment */}
              <div className="w-14" />
            </div>
            
            {isComplete && (
              <p className="text-center text-green-400 mt-4 font-medium">
                ✓ All 6 sides captured! Tap to finish.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default CubemapScanner;
