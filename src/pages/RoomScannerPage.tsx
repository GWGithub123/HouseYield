/**
 * Room Scanner Page
 * Full-page wrapper for the 3D room scanner
 * Shows QR code on desktop for mobile scanning
 * Supports token-based auth for mobile devices
 * Includes saved scans gallery
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';

// Wake Lock hook to keep screen awake during processing
function useWakeLock() {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  
  const requestWakeLock = useCallback(async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        console.log('[WakeLock] Screen wake lock acquired');
        
        wakeLockRef.current?.addEventListener('release', () => {
          console.log('[WakeLock] Screen wake lock released');
        });
        
        return true;
      } else {
        console.warn('[WakeLock] Wake Lock API not supported');
        return false;
      }
    } catch (err: any) {
      console.error('[WakeLock] Failed to acquire:', err.message);
      return false;
    }
  }, []);
  
  const releaseWakeLock = useCallback(async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log('[WakeLock] Released manually');
      } catch (err) {
        console.error('[WakeLock] Failed to release:', err);
      }
    }
  }, []);
  
  // Re-acquire wake lock when page becomes visible again
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && wakeLockRef.current === null) {
        // Try to re-acquire if we had one before
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseWakeLock();
    };
  }, [releaseWakeLock]);
  
  return { requestWakeLock, releaseWakeLock, isActive: () => wakeLockRef.current !== null };
}
import Model3DViewer from '../components/Model3DViewer';
import { Model3DResult, CapturedFrame } from '../types/roomScanner';
import { RoomTourJob } from '../types/roomTour';
import { PanoramaPhoto, StitchedPanorama } from '../types/panoramaScanner';
import { getRoomTourJob } from '../services/roomTourService';
import { 
  isMobile, 
  listSavedScans, 
  loadSavedScan,
  deleteSavedScan,
  getScanThumbnailUrl,
  SavedScanSummary,
  saveRoomScan,
  saveSphericalPanorama,
  getDepthMap
} from '../services/roomScannerService';
import { depthMapToPointCloud, mergePointClouds, detectRoomSurfaces, calculateRoomDimensions } from '../services/depth3DService';
import { stitchSphericalPanorama, stitchSphericalPanoramaPreview } from '../services/imageStitchingService';
import { useAuth } from '../contexts/AuthContext';
import { CubemapFaces, DepthMaps } from '../components/CubemapViewer';
import { buildScannerPublicUrl, getScannerApiBaseUrl, getScannerPublicBaseUrl } from '../services/mobileScanConfig';

// Lazy load the viewers and scanners
const CubemapViewer = React.lazy(() => import('../components/CubemapViewer'));
const SphereViewer = React.lazy(() => import('../components/SphereViewer'));
const SphericalPanoramaViewer = React.lazy(() => import('../components/SphericalPanoramaViewer_NEW'));
const CubemapScanner = React.lazy(() => import('../components/CubemapScanner'));
const PanoramaScanner = React.lazy(() => import('../components/PanoramaScanner'));
const AutoPanoramaScanner = React.lazy(() => import('../components/AutoPanoramaScanner'));
const RoomScanner = React.lazy(() => import('../components/RoomScanner'));
const LiveRenovationScanner = React.lazy(() => import('../components/LiveRenovationScanner'));
const RoomTourVideoCapture = React.lazy(() => import('../components/RoomTourVideoCapture'));

function formatSavedScanTimestamp(value: string | number | Date | undefined): string {
  const candidate = value ? new Date(value) : null;
  if (!candidate || Number.isNaN(candidate.getTime())) {
    return 'Unknown time';
  }
  return candidate.toLocaleString([], {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const RoomScannerPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  
  // Wake lock to keep screen awake during depth processing
  const { requestWakeLock, releaseWakeLock } = useWakeLock();
  
  const propertyId = searchParams.get('propertyId') || undefined;
  const roomName = searchParams.get('room') || 'Room';
  const mobileToken = searchParams.get('token');
  const viewScanId = searchParams.get('viewScan');
  
  const [completedModel, setCompletedModel] = useState<Model3DResult | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [showCubemapScanner, setShowCubemapScanner] = useState(false);
  const [showPanoramaScanner, setShowPanoramaScanner] = useState(false);
  const [showAutoPanoramaScanner, setShowAutoPanoramaScanner] = useState(false);
  const [showLiveRenovationScanner, setShowLiveRenovationScanner] = useState(false);
  const [showLiveRenovationSetup, setShowLiveRenovationSetup] = useState(false);
  const [showRoomTourVideoCapture, setShowRoomTourVideoCapture] = useState(false);
  const [showScanModeSelection, setShowScanModeSelection] = useState(false);
  const [showDesktopPrompt, setShowDesktopPrompt] = useState(false);
  const [showUploadOption, setShowUploadOption] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [previewPhotos, setPreviewPhotos] = useState<Array<{ id: string; url: string; name: string }>>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [ngrokUrl, setNgrokUrl] = useState<string | null>(null);
  const [tokenValidating, setTokenValidating] = useState(!!mobileToken);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenUser, setTokenUser] = useState<any>(null); // User from token validation
  const autoOpenedScanRef = useRef<string | null>(null);
  
  // Live Renovation setup state
  const [renovationRoomType, setRenovationRoomType] = useState<'kitchen' | 'bathroom' | 'bedroom' | 'living_room' | 'basement' | 'other'>('other');
  const [renovationAddress, setRenovationAddress] = useState('');
  const [renovationZipCode, setRenovationZipCode] = useState('');
  const [renovationRoomName, setRenovationRoomName] = useState(roomName);
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  
  // Saved scans state
  const [savedScans, setSavedScans] = useState<SavedScanSummary[]>([]);
  const [loadingScans, setLoadingScans] = useState(true);
  const [selectedCubemap, setSelectedCubemap] = useState<{ faces: CubemapFaces; name: string } | null>(null);
  const [selectedPanorama, setSelectedPanorama] = useState<{ photos: any[]; name: string } | null>(null);
  const [stitchedPanorama, setStitchedPanorama] = useState<StitchedPanorama | null>(null);
  const [depthMaps, setDepthMaps] = useState<DepthMaps | null>(null);
  const [isProcessingDepth, setIsProcessingDepth] = useState(false);
  const [depthProgress, setDepthProgress] = useState(0);
  const [loadingScanId, setLoadingScanId] = useState<string | null>(null);
  const [processingMessage, setProcessingMessage] = useState<string>('Processing...');
  const [latestRoomTourJob, setLatestRoomTourJob] = useState<RoomTourJob | null>(null);

  // Process depth maps for cubemap faces
  const processDepthMaps = useCallback(async (faces: CubemapFaces) => {
    setIsProcessingDepth(true);
    setDepthProgress(0);
    
    const faceKeys: (keyof CubemapFaces)[] = ['front', 'back', 'left', 'right', 'up', 'down'];
    const newDepthMaps: DepthMaps = {};
    
    for (let i = 0; i < faceKeys.length; i++) {
      const key = faceKeys[i];
      const imageData = faces[key];
      
      try {
        console.log(`[DepthMaps] Processing ${key} (${i + 1}/6)...`);
        const result = await getDepthMap(imageData);
        
        if (result?.success && result.depth?.depthImageUrl) {
          newDepthMaps[key] = result.depth.depthImageUrl;
          console.log(`[DepthMaps] Got depth for ${key}`);
        } else {
          console.warn(`[DepthMaps] No depth data for ${key}:`, result?.message);
        }
      } catch (err) {
        console.error(`[DepthMaps] Error processing ${key}:`, err);
      }
      
      setDepthProgress(Math.round(((i + 1) / 6) * 100));
    }
    
    setDepthMaps(newDepthMaps);
    setIsProcessingDepth(false);
    console.log('[DepthMaps] Completed, got depth for:', Object.keys(newDepthMaps));
  }, []);

  // Handle cubemap scan completion
  const handleCubemapComplete = async (faces: CubemapFaces, name: string) => {
    console.log('[CubemapScanner] handleCubemapComplete called');
    console.log('[CubemapScanner] Received faces:', Object.keys(faces));
    
    // Acquire wake lock to keep screen awake during depth processing
    console.log('[CubemapScanner] Requesting wake lock for depth processing...');
    await requestWakeLock();
    
    // IMPORTANT: Convert in the correct order matching FACE_ORDER in CubemapScanner
    // Order: front, right, back, left, up, down
    const orderedFaces: Array<[string, string]> = [
      ['front', faces.front],
      ['right', faces.right],
      ['back', faces.back],
      ['left', faces.left],
      ['up', faces.up],
      ['down', faces.down]
    ];
    
    console.log('[CubemapScanner] Ordered faces for processing:', orderedFaces.map(([key, data]) => 
      `${key}: ${data ? 'present' : 'MISSING'}`
    ));
    
    // Convert to frames format for depth processing (maintaining order)
    const frames: CapturedFrame[] = orderedFaces.map(([direction, imageData], i) => ({
      id: `cubemap-${direction}-${Date.now()}`,
      timestamp: Date.now() + i,
      imageData,
      orientation: { alpha: 0, beta: 0, gamma: 0, absolute: false },
      quality: { blur: 0, brightness: 0.5, contrast: 0.7, usable: true, issues: [] }
    }));
    
    setIsProcessingDepth(true);
    setDepthProgress(0);
    
    try {
      // Process depth maps for all 6 faces using ZoeDepth
      console.log('[CubemapScanner] Starting ZoeDepth processing for room dimensions...');
      const { prepareFramesForViewer } = await import('../services/roomScannerService');
      
      const result = await prepareFramesForViewer(
        frames,
        6, // Process all 6 faces
        (progress, message) => {
          setDepthProgress(progress);
          console.log(`[CubemapScanner] Progress: ${progress}% - ${message}`);
        },
        true // Use ZoeDepth for metric depth
      );
      
      console.log('[CubemapScanner] Depth processing complete!');
      console.log('[CubemapScanner] Room dimensions:', result.roomDimensions);
      console.log('[CubemapScanner] Metric depth frames:', result.metricDepthCount);
      
      // Save to backend with room dimensions
      const saveResult = await saveRoomScan(name, result.frames, {
        propertyId,
        thumbnailImage: faces.front,
        metadata: { 
          scanType: 'cubemap',
          roomDimensions: result.roomDimensions,
          metricDepthFrameCount: result.metricDepthCount
        }
      });
      
      if (saveResult.success) {
        console.log('[CubemapScanner] Saved with ID:', saveResult.scanId);
        
        // Show dimensions if calculated
        if (result.roomDimensions) {
          const dims = result.roomDimensions;
          alert(`✅ Room Dimensions Calculated!\n\n` +
            `Width: ${dims.widthFeet.toFixed(1)} ft (${dims.widthMeters.toFixed(1)} m)\n` +
            `Length: ${dims.lengthFeet.toFixed(1)} ft (${dims.lengthMeters.toFixed(1)} m)\n` +
            `Height: ${dims.heightFeet.toFixed(1)} ft (${dims.heightMeters.toFixed(1)} m)\n\n` +
            `Floor Area: ${dims.floorAreaSqFt} sq ft (${dims.floorAreaSqM.toFixed(1)} sq m)\n` +
            `Confidence: ${(dims.confidence * 100).toFixed(0)}%`
          );
        }
        
        // Reconstruct faces from processed frames (they have the correct imageData)
        const reconstructedFaces: CubemapFaces = {
          front: result.frames[0]?.imageData || faces.front,
          right: result.frames[1]?.imageData || faces.right,
          back: result.frames[2]?.imageData || faces.back,
          left: result.frames[3]?.imageData || faces.left,
          up: result.frames[4]?.imageData || faces.up,
          down: result.frames[5]?.imageData || faces.down
        };
        
        console.log('[CubemapScanner] Reconstructed faces:', {
          front: !!reconstructedFaces.front,
          right: !!reconstructedFaces.right,
          back: !!reconstructedFaces.back,
          left: !!reconstructedFaces.left,
          up: !!reconstructedFaces.up,
          down: !!reconstructedFaces.down
        });
        
        setSelectedCubemap({ faces: reconstructedFaces, name });
      }
      
    } catch (error) {
      console.error('[CubemapScanner] Depth processing error:', error);
      alert('Room dimensions calculation failed, but scan was saved.');
    } finally {
      setIsProcessingDepth(false);
      setDepthProgress(0);
      // Release wake lock when processing completes
      await releaseWakeLock();
      console.log('[CubemapScanner] Wake lock released after processing');
    }
    
    // Refresh scans list
    fetchSavedScans();
  };

  // Handle panorama scan completion
  const handlePanoramaComplete = async (photos: PanoramaPhoto[], name: string) => {
    console.log('[PanoramaScanner] Completed with', photos.length, 'photos');
    
    // Close scanner immediately to show processing UI
    setShowPanoramaScanner(false);
    
    processUploadedPanorama(photos, name);
  };

  // Handle file upload for pre-existing photos
  const handlePhotoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const newFiles = Array.from(files);
    // Append to existing files instead of replacing
    const allFiles = [...pendingFiles, ...newFiles];
    loadFilePreviews(allFiles);
    
    // Reset input so same files can be selected again if needed
    event.target.value = '';
  };

  // Handle drag and drop
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      // Append to existing files instead of replacing
      const allFiles = [...pendingFiles, ...files];
      loadFilePreviews(allFiles);
    }
  };

  // Load file previews before processing
  const loadFilePreviews = async (files: File[]) => {
    console.log('[Upload] Loading previews for', files.length, 'files');
    
    // Note: HEIC files will be converted to JPEG on the backend
    // But browsers can't display HEIC thumbnails, so they'll show placeholders
    
    setPendingFiles(files);
    
    // Use FileReader to create base64 data URLs
    const previewPromises = files.map((file, index) => {
      return new Promise<{ id: string; url: string; name: string }>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          console.log(`[Upload] Loaded preview for ${file.name}:`, dataUrl.substring(0, 50) + '...');
          resolve({
            id: `preview-${index}-${Date.now()}`,
            url: dataUrl,
            name: file.name
          });
        };
        reader.onerror = () => {
          console.error(`[Upload] Failed to read ${file.name}`);
          // Return a placeholder
          resolve({
            id: `preview-${index}-${Date.now()}`,
            url: '',
            name: file.name
          });
        };
        reader.readAsDataURL(file);
      });
    });
    
    const previews = await Promise.all(previewPromises);
    console.log('[Upload] All previews loaded:', previews.length);
    setPreviewPhotos(previews);
  };

  // Process uploaded or dropped files
  const processFiles = async (files: File[]) => {
    if (files.length < 24 || files.length > 26) {
      alert(`⚠️ Please select 24-26 images.\n\nYou selected ${files.length} images.`);
      setPreviewPhotos([]);
      return;
    }

    console.log('[Upload] Processing', files.length, 'uploaded files');

    const loadedPhotos: PanoramaPhoto[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        loadedPhotos.push({
          imageData: base64,
          timestamp: Date.now(),
          azimuth: (i % 12) * 30,
          elevation: i < 1 ? 90 : i < 7 ? 60 : i < 15 ? 30 : 0,
          ringIndex: Math.floor(i / 6),
          photoIndex: i % 6,
          type: i < 1 ? 'zenith' : i < 7 ? 'ring' : 'nadir'
        });
      } catch (error) {
        console.error('[Upload] Failed to read file:', file.name, error);
      }
    }

    if (loadedPhotos.length === files.length) {
      console.log('[Upload] All photos loaded successfully');
      processUploadedPanorama(loadedPhotos, `Uploaded Scan ${new Date().toLocaleString()}`);
    } else {
      alert(`⚠️ Only ${loadedPhotos.length} of ${files.length} images loaded successfully.`);
    }
  };

  // Process uploaded or captured panorama photos
  const processUploadedPanorama = async (photos: PanoramaPhoto[], _name: string) => {
    
    try {
      // Phase 1: Process depth maps in BATCHES to avoid overwhelming API
      setIsProcessingDepth(true);
      setProcessingMessage('Getting depth maps (warming up model)...');
      setDepthProgress(5);
      
      console.log('[Panorama] Starting SEQUENTIAL depth processing for', photos.length, 'photos');
      
      const BATCH_SIZE = 1; // Process one at a time to ensure quality and avoid API rate limits
      const BATCH_DELAY = 3000; // 3 seconds between photos for API breathing room
      const photosWithDepth: Array<{ photo: PanoramaPhoto; depthMap: any }> = [];
      
      // Process in batches
      for (let batchStart = 0; batchStart < photos.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, photos.length);
        const batch = photos.slice(batchStart, batchEnd);
        const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(photos.length / BATCH_SIZE);
        
        console.log(`[Depth] Processing photo ${batchNum}/${totalBatches} (${batchStart + 1}/${photos.length})`);
        setProcessingMessage(`Processing depth map ${batchNum}/${totalBatches}...`);
        
        // Process batch in parallel with retry
        const batchPromises = batch.map(async (photo, i) => {
          const photoIndex = batchStart + i;
          
          // Retry logic for timeouts
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const result = await getDepthMap(photo.imageData, true);
              if (result?.success && result.depth) {
                console.log(`[Depth] ✅ Photo ${photoIndex + 1}/${photos.length} (${photo.elevation}° @ ${photo.azimuth}°) - Attempt ${attempt}`);
                return { photo, depthMap: result.depth };
              }
            } catch (err) {
              console.error(`[Depth] ❌ Photo ${photoIndex + 1} attempt ${attempt}:`, err);
              
              // Exponential backoff: 5s, 10s, 20s
              if (attempt < 3) {
                const delay = 5000 * Math.pow(2, attempt - 1);
                console.log(`[Depth] Retrying photo ${photoIndex + 1} in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
              }
            }
          }
          
          console.warn(`[Depth] ⚠️ Photo ${photoIndex + 1} failed after 3 attempts, skipping`);
          return { photo, depthMap: null };
        });
        
        const batchResults = await Promise.all(batchPromises);
        photosWithDepth.push(...batchResults);
        
        // Update progress
        const progress = 10 + (batchEnd / photos.length) * 30;
        setDepthProgress(Math.round(progress));
        
        // Delay between batches (except last batch)
        if (batchEnd < photos.length) {
          console.log(`[Depth] Waiting ${BATCH_DELAY}ms before next batch...`);
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
      }
      
      const successCount = photosWithDepth.filter(p => p.depthMap !== null).length;
      console.log(`[Depth] Completed: ${successCount}/${photos.length} photos processed successfully`);
      
      setDepthProgress(40);
      
      // Phase 2: Create point clouds from depth maps (MEMORY-SAFE)
      setProcessingMessage('Creating 3D point clouds...');
      console.log('[Panorama] Creating point clouds with aggressive subsampling');
      
      const pointCloudPromises = photosWithDepth.map(async ({ photo, depthMap }) => {
        if (!depthMap) return { photo, points3D: [], camera: photo };
        
        // Aggressive subsampling: every 10th pixel = 9,216 points per 720x1280 image
        // Total for 26 images: ~240K points (manageable for browser)
        const points = await depthMapToPointCloud(photo, depthMap, 10);
        console.log(`[PointCloud] Generated ${points.length} points for photo at ${photo.elevation}° elevation`);
        return {
          photo,
          points3D: points,
          camera: photo
        };
      });
      
      const photos3D = await Promise.all(pointCloudPromises);
      setDepthProgress(60);
      
      // Phase 3: Merge point clouds (with crash protection)
      setProcessingMessage('Merging point clouds...');
      console.log('[Panorama] Merging', photos3D.length, 'point clouds');
      
      let mergedPointCloud: any[] = [];
      let roomDimensions;
      
      try {
        mergedPointCloud = mergePointClouds(photos3D as any);
        console.log('[Panorama] Merged to', mergedPointCloud.length, 'points');
        setDepthProgress(75);
        
        // Phase 4: Detect room surfaces and calculate dimensions
        setProcessingMessage('Analyzing room geometry...');
        console.log('[Panorama] Detecting surfaces from', mergedPointCloud.length, 'points');
        
        const surfaces = detectRoomSurfaces(mergedPointCloud);
        roomDimensions = calculateRoomDimensions(surfaces);
        console.log('[Panorama] Room dimensions calculated');
      } catch (error) {
        console.error('[Panorama] Error in point cloud merging/analysis:', error);
        mergedPointCloud = []; // Clear to save memory
        roomDimensions = {
          width: 0,
          widthMeters: 0,
          widthFeet: 0,
          length: 0,
          lengthMeters: 0,
          lengthFeet: 0,
          height: 0,
          heightMeters: 0,
          heightFeet: 0,
          volume: 0,
          floorArea: 0,
          floorAreaSqM: 0,
          floorAreaSqFt: 0,
          confidence: 0,
          measurements: []
        };
      }
      
      setDepthProgress(85);
      
      // Phase 5: Full OpenCV panorama stitching with backend
      setProcessingMessage('Stitching panorama with OpenCV...');
      console.log('[Panorama] Starting high-quality backend stitching');
      
      // IMPORTANT: Merge depth maps back into the photos for stitching
      // Use index-based matching since object references might not match
      const photosWithDepthMaps = photos.map((photo, index) => {
        // Find depth result by matching index or photo properties
        const depthResult = photosWithDepth[index] || 
          photosWithDepth.find(p => 
            p.photo.azimuth === photo.azimuth && 
            p.photo.elevation === photo.elevation
          );
        
        if (depthResult?.depthMap) {
          console.log(`[Panorama] ✅ Photo ${index + 1} has depth map:`, {
            hasDepthImageData: !!depthResult.depthMap.depthImageData,
            hasDepthImageUrl: !!depthResult.depthMap.depthImageUrl,
            depthRange: `${depthResult.depthMap.minDepth}m - ${depthResult.depthMap.maxDepth}m`
          });
          return {
            ...photo,
            depthMap: depthResult.depthMap
          };
        }
        console.log(`[Panorama] ❌ Photo ${index + 1} missing depth map`);
        return photo;
      });
      
      const depthCount = photosWithDepthMaps.filter(p => p.depthMap).length;
      console.log(`[Panorama] Merged ${depthCount}/${photos.length} depth maps into photos for stitching`);
      
      // Start progress animation while stitching
      let progressInterval: ReturnType<typeof setInterval> | null = null;
      let currentProgress = 85;
      
      let stitchResult: StitchedPanorama;
      try {
        // Slowly increment progress to show it's working (86-94%)
        progressInterval = setInterval(() => {
          if (currentProgress < 94) {
            currentProgress++;
            setDepthProgress(currentProgress);
            
            // Update message based on progress
            if (currentProgress === 87) {
              setProcessingMessage('Detecting features in all photos...');
            } else if (currentProgress === 89) {
              setProcessingMessage('Matching overlapping regions...');
            } else if (currentProgress === 91) {
              setProcessingMessage('Calculating camera positions...');
            } else if (currentProgress === 93) {
              setProcessingMessage('Blending images seamlessly...');
            }
          }
        }, 5000); // Update every 5 seconds
        
        stitchResult = await stitchSphericalPanorama(photosWithDepthMaps);
        
        if (progressInterval) clearInterval(progressInterval);
        setDepthProgress(95);
        
        console.log('[Panorama] Backend stitch success:', {
          hasEquirectangular: !!stitchResult.equirectangular,
          equirectangularLength: stitchResult.equirectangular?.length,
          equirectangularType: typeof stitchResult.equirectangular,
          equirectangularPreview: stitchResult.equirectangular?.substring(0, 100),
          quality: stitchResult.stitchQuality,
          fullResult: stitchResult
        });
      } catch (error) {
        if (progressInterval) clearInterval(progressInterval);
        console.warn('[Panorama] Backend stitching failed:', error);
        console.log('[Panorama] Falling back to preview mode');
        setProcessingMessage('Using preview stitching...');
        stitchResult = await stitchSphericalPanoramaPreview(photos) as StitchedPanorama;
        console.log('[Panorama] Preview result:', {
          hasEquirectangular: !!stitchResult.equirectangular,
          equirectangularLength: stitchResult.equirectangular?.length
        });
      }
      
      // Phase 6: Create final stitched panorama object
      const finalEquirectangular = stitchResult.equirectangular || photos[0]?.imageData || '';
      console.log('[Panorama] Final equirectangular:', {
        source: finalEquirectangular === stitchResult.equirectangular ? 'stitched' : 'fallback',
        length: finalEquirectangular.length,
        isDataURL: finalEquirectangular.startsWith('data:'),
        preview: finalEquirectangular.substring(0, 50)
      });
      
      // Validate we have a valid image
      if (!finalEquirectangular || finalEquirectangular.length < 100) {
        const errorMsg = 'Failed to generate panorama image';
        console.error('[Panorama]', errorMsg);
        alert(`⚠️ ${errorMsg}\n\nStitched: ${stitchResult.equirectangular?.length || 0} bytes\nFallback photo: ${photos[0]?.imageData?.length || 0} bytes`);
        throw new Error(errorMsg);
      }
      
      const stitched: StitchedPanorama = {
        equirectangular: finalEquirectangular,
        depthPanorama: stitchResult.depthPanorama, // Include depth panorama from backend
        pointCloud: mergedPointCloud,
        roomDimensions,
        stitchQuality: stitchResult.stitchQuality || 0.8,
        processingTime: stitchResult.processingTime || 0
      };
      
      console.log('[Panorama] ✅ Processing complete!');
      console.log('[Panorama] Room dimensions:', roomDimensions);
      console.log('[Panorama] Success rate:', `${successCount}/${photos.length} depth maps`);
      console.log('[Panorama] Has depth panorama:', !!stitched.depthPanorama);
      console.log('[Panorama] Opening viewer with equirectangular length:', stitched.equirectangular.length);
      
      // CRITICAL: Save the spherical panorama to backend so it appears in saved scans
      setProcessingMessage('Saving 3D panorama...');
      setDepthProgress(98);
      
      try {
        const scanName = _name || `Panorama ${new Date().toLocaleString()}`;
        
        console.log('🔥 [Panorama v3.0] Saving spherical panorama with NEW clean format');
        
        const saveResult = await saveSphericalPanorama(scanName, stitched.equirectangular, {
          propertyId,
          roomDimensions: roomDimensions ? {
            widthFeet: roomDimensions.widthFeet,
            lengthFeet: roomDimensions.lengthFeet,
            heightFeet: roomDimensions.heightFeet,
            floorAreaSqFt: roomDimensions.floorAreaSqFt,
            floorAreaSqM: roomDimensions.floorAreaSqM,
            confidence: roomDimensions.confidence
          } : undefined,
          metadata: {
            photoCount: photos.length,
            depthMapCount: successCount,
            stitchQuality: stitched.stitchQuality,
            processingTime: stitched.processingTime,
            hasPointCloud: mergedPointCloud.length > 0,
            pointCloudSize: mergedPointCloud.length
          }
        });
        
        if (saveResult.success) {
          console.log('🔥 [Panorama v3.0] ✅ Saved spherical panorama:', saveResult.scanId);
          
          // Show success with dimensions if available
          if (roomDimensions) {
            const dims = roomDimensions;
            console.log(`[Panorama] Room Dimensions:\n` +
              `${dims.widthFeet.toFixed(1)} ft × ${dims.lengthFeet.toFixed(1)} ft × ${dims.heightFeet.toFixed(1)} ft\n` +
              `Floor: ${dims.floorAreaSqFt} sq ft (${dims.floorAreaSqM.toFixed(1)} m²)\n` +
              `Confidence: ${(dims.confidence * 100).toFixed(0)}%`);
          }
          
          // Refresh saved scans list to show the new panorama
          fetchSavedScans();
        } else {
          console.error('[Panorama] Failed to save:', saveResult.error);
        }
      } catch (saveError) {
        console.error('[Panorama] Save error:', saveError);
        // Don't block viewing even if save fails
      }
      
      setStitchedPanorama(stitched);
      setIsProcessingDepth(false);
      setDepthProgress(100);
      
    } catch (error) {
      console.error('[PanoramaScanner] Error:', error);
      setIsProcessingDepth(false);
      setDepthProgress(0);
      setShowPanoramaScanner(false);
      alert('Failed to process panorama: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  // Load saved scans
  const fetchSavedScans = useCallback(async () => {
    const result = await listSavedScans({ propertyId });
    if (result.success && result.scans) {
      setSavedScans(result.scans);
    }
    setLoadingScans(false);
  }, [propertyId]);

  useEffect(() => {
    setLoadingScans(true);
    fetchSavedScans();
    
    // Auto-refresh every 5 seconds on desktop to catch new scans from phone
    if (!isMobile) {
      const interval = setInterval(fetchSavedScans, 5000);
      return () => clearInterval(interval);
    }
  }, [fetchSavedScans]);

  useEffect(() => {
    if (!latestRoomTourJob?.id) {
      return undefined;
    }

    if (latestRoomTourJob.status === 'completed' || latestRoomTourJob.status === 'failed') {
      return undefined;
    }

    let cancelled = false;

    const pollJob = async () => {
      try {
        const freshJob = await getRoomTourJob(latestRoomTourJob.id);
        if (cancelled) {
          return;
        }

        setLatestRoomTourJob(freshJob);

        if (freshJob.status === 'completed') {
          fetchSavedScans();
        }
      } catch (error) {
        console.error('[RoomScanner] Failed to refresh room-tour job:', error);
      }
    };

    pollJob();
    const intervalId = window.setInterval(pollJob, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [fetchSavedScans, latestRoomTourJob?.id, latestRoomTourJob?.status]);

  // Load a saved scan for viewing
  const handleViewScan = async (scanId: string) => {
    console.log('🔥🔥🔥 handleViewScan v3.0 - WITH PHOTOGRAMMETRY 🔥🔥🔥');
    setLoadingScanId(scanId);
    
    // First check if this is a photogrammetry scan by looking at savedScans
    const scan = savedScans.find(s => s.id === scanId);
    const isPhotogrammetry = (scan as any)?.type === 'photogrammetry' || (scan as any)?.metadata?.scanType === 'photogrammetry';
    
    if (isPhotogrammetry) {
      console.log('[RoomScanner] Opening photogrammetry scan viewer:', scanId);
      setLoadingScanId(null);
      navigate(`/photogrammetry-view/${scanId}`);
      return;
    }
    
    // Regular room scanner scan - load and display
    const result = await loadSavedScan(scanId);
    setLoadingScanId(null);
    
    if (result.success && result.scan) {
      // Cast to any for spherical panorama fields that may not be in the base type
      const scan = result.scan as any;
      
      console.log('[RoomScanner] Loading scan v2.0:', {
        id: scanId,
        name: scan.roomName,
        frames: scan.frames?.length || 0,
        type: scan.type,
        scanType: scan.scanType,
        hasEquirectangular: !!scan.equirectangular,
        metadata: scan.metadata
      });
      
      // Check scan type - can be at top level OR in metadata
      const scanType = scan.type || scan.scanType || scan.metadata?.scanType;
      console.log('[RoomScanner] Detected scanType:', scanType);
      
      if (scanType === 'spherical_panorama') {
        // This is a saved spherical panorama with stitched equirectangular image
        console.log('[RoomScanner] Loading spherical panorama scan');
        
        // For auto-saved scans, equirectangular is at top level
        // For client-saved scans, first frame is the stitched equirectangular
        const equirectangularImage = scan.equirectangular || scan.frames?.[0]?.imageData;
        
        if (!equirectangularImage) {
          console.error('[RoomScanner] No equirectangular image found in spherical panorama');
          alert('Failed to load panorama: No image data found');
          return;
        }
        
        // Reconstruct the StitchedPanorama object with all data
        // Cast metadata to any since it's dynamically typed from backend
        const metadata = scan.metadata as any;
        const savedDims = metadata?.roomDimensions || scan.roomDimensions;
        
        // Build depth panorama object with both data and metadata
        let depthPanoramaObj: import('../types/panoramaScanner').DepthPanoramaResult | undefined = undefined;
        if (scan.depthPanorama) {
          const minD = scan.depthMetadata?.minDepth || metadata?.depthRange?.min || 0;
          const maxD = scan.depthMetadata?.maxDepth || metadata?.depthRange?.max || 10;
          depthPanoramaObj = {
            data: scan.depthPanorama,
            // Include metadata from depthMetadata or from scan metadata
            minDepth: minD,
            maxDepth: maxD,
            meanDepth: (minD + maxD) / 2, // Estimate mean as midpoint
            medianDepth: (minD + maxD) / 2, // Estimate median as midpoint
            width: scan.depthMetadata?.width || metadata?.width || 4096,
            height: scan.depthMetadata?.height || metadata?.height || 2048,
            coverage: scan.depthMetadata?.coverage || 100,
          };
          console.log('[RoomScanner] ✅ Loaded depth panorama with metadata:', {
            minDepth: depthPanoramaObj.minDepth,
            maxDepth: depthPanoramaObj.maxDepth,
            coverage: depthPanoramaObj.coverage,
          });
        }
        
        const stitched: StitchedPanorama = {
          equirectangular: equirectangularImage,
          depthPanorama: depthPanoramaObj,
          pointCloud: [], // Point cloud not stored, would need to regenerate
          roomDimensions: {
            // Try both meters and feet - auto-saved scans have meters from depth estimate
            width: savedDims?.widthMeters || (savedDims?.widthFeet ? savedDims.widthFeet * 0.3048 : 0),
            widthMeters: savedDims?.widthMeters || (savedDims?.widthFeet ? savedDims.widthFeet * 0.3048 : 0),
            widthFeet: savedDims?.widthFeet || (savedDims?.widthMeters ? savedDims.widthMeters * 3.28084 : 0),
            length: savedDims?.lengthMeters || (savedDims?.lengthFeet ? savedDims.lengthFeet * 0.3048 : 0),
            lengthMeters: savedDims?.lengthMeters || (savedDims?.lengthFeet ? savedDims.lengthFeet * 0.3048 : 0),
            lengthFeet: savedDims?.lengthFeet || (savedDims?.lengthMeters ? savedDims.lengthMeters * 3.28084 : 0),
            height: savedDims?.heightMeters || (savedDims?.heightFeet ? savedDims.heightFeet * 0.3048 : 0),
            heightMeters: savedDims?.heightMeters || (savedDims?.heightFeet ? savedDims.heightFeet * 0.3048 : 0),
            heightFeet: savedDims?.heightFeet || (savedDims?.heightMeters ? savedDims.heightMeters * 3.28084 : 0),
            volume: 0,
            floorArea: savedDims?.floorAreaSqM || 0,
            floorAreaSqM: savedDims?.floorAreaSqM || 0,
            floorAreaSqFt: savedDims?.floorAreaSqFt || 0,
            confidence: savedDims?.confidence || 0,
            measurements: []
          },
          stitchQuality: metadata?.stitchQuality || 0.9,
          processingTime: metadata?.processingTime || 0,
          pointCloudFile: scan.pointCloudFile || metadata?.pointCloudFile
        };
        
        console.log('[RoomScanner] Raw savedDims from backend:', savedDims);
        console.log('[RoomScanner] Point cloud file:', stitched.pointCloudFile);
        console.log('[RoomScanner] Loaded spherical panorama with dimensions:', stitched.roomDimensions);
        console.log('[RoomScanner] Has depth panorama:', !!scan.depthPanorama);
        console.log('[RoomScanner] Equirectangular image length:', equirectangularImage.length);
        setStitchedPanorama(stitched);
        
      } else if (scan.frames && scan.frames.length > 6) {
        // Legacy panorama scan (pre-stitched) - load as individual photos
        const photos = scan.frames.map((frame: any) => ({
          angle: frame.angle || 0,
          imageData: frame.imageData,
          type: frame.type || 'horizontal',
          depthData: frame.depthData
        }));
        
        console.log('[RoomScanner] Loaded legacy panorama scan with', photos.length, 'photos');
        setSelectedPanorama({ photos, name: scan.roomName });
        
      } else if (scan.equirectangular || scan.frames?.[0]?.imageData) {
        // Fallback: Even if type isn't set, try to load as spherical panorama if we have an image
        console.log('[RoomScanner] Fallback: Loading as spherical panorama despite unknown type');
        const equirectangularImage = scan.equirectangular || scan.frames?.[0]?.imageData;
        
        const stitched: StitchedPanorama = {
          equirectangular: equirectangularImage,
          pointCloud: [],
          roomDimensions: {
            width: 0, widthMeters: 0, widthFeet: 0,
            length: 0, lengthMeters: 0, lengthFeet: 0,
            height: 0, heightMeters: 0, heightFeet: 0,
            volume: 0, floorArea: 0, floorAreaSqM: 0, floorAreaSqFt: 0,
            confidence: 0, measurements: []
          },
          stitchQuality: 0.9,
          processingTime: 0
        };
        setStitchedPanorama(stitched);
      } else {
        // No valid data found
        console.error('[RoomScanner] No valid scan data found:', scan);
        alert('Failed to load scan: No image data found');
      }
    }
  };

  useEffect(() => {
    if (!viewScanId || loadingScans || autoOpenedScanRef.current === viewScanId) {
      return;
    }

    const scanExists = savedScans.some((scan) => scan.id === viewScanId);
    if (!scanExists) {
      return;
    }

    autoOpenedScanRef.current = viewScanId;
    handleViewScan(viewScanId);
  }, [viewScanId, loadingScans, savedScans, handleViewScan]);

  // Delete a saved scan
  const handleDeleteScan = async (scanId: string) => {
    if (!confirm('Are you sure you want to delete this room scan?')) return;
    
    const result = await deleteSavedScan(scanId);
    if (result.success) {
      setSavedScans(prev => prev.filter(s => s.id !== scanId));
    }
  };

  // Validate mobile scan token if present
  useEffect(() => {
    const validateToken = async () => {
      if (!mobileToken) {
        setTokenValidating(false);
        return;
      }
      
      // Skip if user is already authenticated via normal auth
      if (user) {
        console.log('[RoomScanner] User already authenticated, skipping token validation');
        setTokenValidating(false);
        return;
      }
      
      try {
        setTokenValidating(true);
        setTokenError(null);
        
        console.log('[RoomScanner] Validating mobile token...');
        
        const apiBase = getScannerApiBaseUrl();
        
        const response = await fetch(`${apiBase}/api/auth/validate-mobile-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: mobileToken })
        });
        
        const data = await response.json();
        console.log('[RoomScanner] Token validation response:', data);
        
        if (data.ok && data.user) {
          // Token is valid - keep the resolved user local to this page.
          console.log('[RoomScanner] Token validated successfully for user:', data.user.email);
          
          // Store token in sessionStorage so roomScannerService can attach
          // it to API requests when accessed through the tunnel gateway
          if (mobileToken) {
            sessionStorage.setItem('mobileScanToken', mobileToken);
          }
          
          const authenticatedUser = {
            id: data.user.id,
            email: data.user.email,
            name: data.user.name,
            role: data.user.role,
            properties: data.user.properties || []
          };
          
          // Store the user locally so we can proceed without reload
          setTokenUser(authenticatedUser);
          console.log('[RoomScanner] Auth set, ready to show scanner');
        } else {
          console.error('[RoomScanner] Token validation failed:', data.error);
          setTokenError(data.error || 'Token validation failed');
        }
      } catch (error) {
        console.error('[RoomScanner] Token validation error:', error);
        setTokenError('Failed to validate scan token. Please try again.');
      } finally {
        setTokenValidating(false);
      }
    };
    
    validateToken();
  }, [mobileToken, user]);

  // Determine if we're authenticated (either via context or token)
  const isAuthenticated = !!(user || tokenUser);

  // Get the public scanner URL for QR code access.
  useEffect(() => {
    const generateQRCode = async () => {
      if (!user) {
        setNgrokUrl(null);
        return;
      }

      try {
        // Generate mobile token for this user and get the preferred scanner host from backend.
        const response = await fetch('/api/auth/mobile-scan-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json'},
          body: JSON.stringify({
            userId: user.id,
            userEmail: user.email,
            userName: user.name,
            userRole: user.role
          })
        });

        const data = await response.json();
        if (data.ok && data.token) {
          const scannerBaseUrl = data.scannerBaseUrl || getScannerPublicBaseUrl() || data.tunnelUrl || null;

          if (!scannerBaseUrl) {
            setNgrokUrl(null);
            console.error('[RoomScanner] No public scanner URL configured');
            return;
          }

          try {
            sessionStorage.setItem('mobileScanToken', data.token);
          } catch {
            // Ignore browsers that block sessionStorage.
          }

          // Construct the full scanner URL with token and cache-busting parameter
          const cacheBuster = `v=${Date.now()}`;
          const scannerPath = `/room-scanner?token=${data.token}${propertyId ? `&propertyId=${propertyId}` : ''}&room=${encodeURIComponent(roomName)}&${cacheBuster}`;
          setNgrokUrl(buildScannerPublicUrl(scannerPath, scannerBaseUrl));
        } else {
          console.error('[RoomScanner] Failed to generate mobile token:', data.error);
        }
      } catch (error) {
        console.error('[RoomScanner] Error generating mobile token:', error);
      }
    };

    generateQRCode();
  }, [propertyId, roomName, user]);

  const handleComplete = (model: Model3DResult) => {
    setCompletedModel(model);
    setShowScanner(false);
  };

  const handleCancel = () => {
    navigate(-1); // Go back
  };

  const handleNewScan = () => {
    setCompletedModel(null);
    setShowScanner(true);
  };

  // Show loading while validating token
  if (tokenValidating) {
    return (
      <div className="fixed inset-0 bg-gray-900 z-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-6"></div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Validating Access...</h2>
          <p className="text-gray-600">Connecting to your account securely.</p>
        </div>
      </div>
    );
  }

  // Show error if token validation failed
  if (tokenError) {
    return (
      <div className="fixed inset-0 bg-gray-900 z-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Access Denied</h2>
          <p className="text-gray-600 mb-6">{tokenError}</p>
          <p className="text-sm text-gray-500 mb-4">
            This QR code may have expired. Please scan a new QR code from your desktop.
          </p>
          <button
            onClick={() => window.close()}
            className="px-6 py-3 bg-gray-600 text-white rounded-lg font-medium hover:bg-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  // Desktop prompt with QR code
  if (showDesktopPrompt && !isMobile) {
    return (
      <div className="fixed inset-0 bg-gray-900 z-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl p-8 max-w-lg w-full text-center">
          <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-10 h-10 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>

          <h2 className="text-2xl font-bold text-gray-900 mb-4">Scan with Your iPhone</h2>
          
          <p className="text-gray-600 mb-6">
            For the best 3D scanning experience, use your iPhone's camera. Scan this QR code to open the scanner on your phone.
          </p>

          {ngrokUrl ? (
            <div className="bg-white p-4 rounded-xl inline-block mb-6 shadow-md">
              <QRCodeSVG 
                value={ngrokUrl} 
                size={200}
                level="M"
                includeMargin={true}
              />
            </div>
          ) : (
            <div className="bg-amber-50 border border-amber-200 p-4 rounded-lg mb-6">
              <p className="text-amber-800 text-sm">
                <strong>Public scanner URL not configured.</strong><br/>
                Set <code className="bg-amber-100 px-1 rounded">VITE_SCANNER_PUBLIC_URL</code> for the hosted scanner, or keep using the local tunnel in development.
              </p>
            </div>
          )}

          {ngrokUrl && (
            <div className="bg-gray-50 p-3 rounded-lg mb-6">
              <p className="text-xs text-gray-500 mb-1">Or open this URL on your phone:</p>
              <p className="text-sm font-mono text-gray-700 break-all">{ngrokUrl}</p>
            </div>
          )}

          <div className="flex gap-3">
            <button
              onClick={handleCancel}
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
            >
              Go Back
            </button>
            <button
              onClick={() => {
                setShowDesktopPrompt(false);
                setShowPanoramaScanner(true);
              }}
              className="flex-1 px-4 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
            >
              Continue on Desktop
            </button>
          </div>

          <p className="text-xs text-gray-400 mt-4">
            Desktop scanning works with your webcam. Console logs will be visible in your browser's developer tools (F12).
          </p>
        </div>
      </div>
    );
  }

  // Show upload option modal
  if (showUploadOption) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4 overflow-y-auto">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full my-8">
          {/* Header - Fixed */}
          <div className="p-8 pb-4">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>

            <h2 className="text-2xl font-bold text-gray-900 mb-4 text-center">Upload Panorama Photos</h2>
            
            <p className="text-gray-600 mb-6 text-center">
              Select or drag and drop 24-26 pre-captured photos to process into a spherical panorama.
            </p>

            <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg mb-6 text-left">
              <p className="text-sm text-blue-900 font-medium mb-2">📸 Photo Requirements:</p>
              <ul className="text-xs text-blue-800 space-y-1">
                <li>• 24-26 photos total</li>
                <li>• Taken in overlapping ring pattern</li>
                <li>• High resolution (1920×1080 or better)</li>
                <li>• Consistent lighting throughout</li>
                <li>• Any image format (JPEG, PNG, <strong>HEIC</strong>) - HEIC auto-converted</li>
              </ul>
            </div>
          </div>

          {/* Scrollable Content Area */}
          <div className="px-8 max-h-96 overflow-y-auto">{/* Drag and Drop Zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`
              border-2 border-dashed rounded-xl p-8 mb-4 transition-all
              ${isDragging 
                ? 'border-green-500 bg-green-50' 
                : 'border-gray-300 bg-gray-50 hover:border-green-400 hover:bg-green-50/50'
              }
            `}
          >
            <div className="text-center">
              <svg 
                className={`w-12 h-12 mx-auto mb-3 transition-colors ${isDragging ? 'text-green-600' : 'text-gray-400'}`}
                fill="none" 
                stroke="currentColor" 
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              <p className={`text-sm font-medium mb-1 ${isDragging ? 'text-green-700' : 'text-gray-700'}`}>
                {isDragging ? 'Drop photos here' : 'Drag and drop photos here'}
              </p>
              <p className="text-xs text-gray-500">or</p>
            </div>
          </div>

          {/* Photo Preview Grid */}
          {previewPhotos.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-gray-700">
                  {previewPhotos.length} photo{previewPhotos.length !== 1 ? 's' : ''} selected
                </p>
                <button
                  onClick={() => {
                    setPreviewPhotos([]);
                    setPendingFiles([]);
                  }}
                  className="text-xs text-red-600 hover:text-red-700 font-medium"
                >
                  Clear
                </button>
              </div>
              <div className="grid grid-cols-6 gap-2 max-h-64 overflow-y-auto p-2 bg-gray-50 rounded-lg border border-gray-200">
                {previewPhotos.map((photo, index) => (
                  <div key={photo.id} className="relative aspect-square bg-gray-200 flex items-center justify-center">
                    <img
                      src={photo.url}
                      alt={photo.name}
                      className="w-full h-full object-cover rounded border border-gray-300"
                      title={photo.name}
                      loading="eager"
                      onLoad={() => {
                        console.log(`[Upload] Image ${index + 1} loaded successfully:`, photo.name);
                      }}
                      onError={(e) => {
                        console.error(`[Upload] Failed to load image ${index + 1}:`, photo.name, 'URL:', photo.url);
                        const target = e.target as HTMLImageElement;
                        target.style.display = 'none';
                        const parent = target.parentElement;
                        if (parent) {
                          parent.innerHTML = `<div class="text-center text-xs text-gray-500 p-2"><div class="text-2xl mb-1">📷</div><div class="break-all">${photo.name.substring(0, 20)}...</div></div>`;
                        }
                      }}
                    />
                  </div>
                ))}
              </div>
              
              {/* Validation Message */}
              {previewPhotos.length < 24 && (
                <p className="text-xs text-amber-600 mt-2">
                  ⚠️ Need {24 - previewPhotos.length} more photo{24 - previewPhotos.length !== 1 ? 's' : ''} (minimum 24)
                </p>
              )}
              {previewPhotos.length > 26 && (
                <p className="text-xs text-amber-600 mt-2">
                  ⚠️ Too many photos. Please remove {previewPhotos.length - 26} (maximum 26)
                </p>
              )}
              {previewPhotos.length >= 24 && previewPhotos.length <= 26 && (
                <p className="text-xs text-green-600 mt-2 flex items-center gap-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Ready to process!
                </p>
              )}
            </div>
          )}
          </div>

          {/* Footer - Fixed Buttons */}
          <div className="p-8 pt-4">
            <label className="block w-full mb-4">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotoUpload}
                className="hidden"
                id="photo-upload-input"
              />
              <div className="px-6 py-4 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors cursor-pointer flex items-center justify-center gap-2">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Browse Files
              </div>
            </label>
          
            {/* Process Button - Only show when valid number of photos */}
            {previewPhotos.length >= 24 && previewPhotos.length <= 26 && (
              <button
                onClick={async () => {
                  setShowUploadOption(false);
                  await processFiles(pendingFiles);
                }}
                className="w-full px-6 py-4 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors mb-4 flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Process {previewPhotos.length} Photos
              </button>
            )}

            <button
              onClick={() => {
                setShowUploadOption(false);
                setPreviewPhotos([]);
                setPendingFiles([]);
              }}
              className="w-full px-6 py-3 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>

            <p className="text-xs text-gray-400 mt-4 text-center">
              Photos will be processed with AI depth estimation and stitched into an interactive 3D panorama.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (showRoomTourVideoCapture) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading video room tour capture...</p>
          </div>
        </div>
      }>
        <RoomTourVideoCapture
          roomName={roomName}
          propertyId={propertyId}
          onComplete={(job) => {
            setLatestRoomTourJob(job);
            setShowRoomTourVideoCapture(false);
          }}
          onCancel={() => {
            setShowRoomTourVideoCapture(false);
          }}
        />
      </React.Suspense>
    );
  }

  // Show 3D viewer if we have a completed model
  if (completedModel && !showScanner) {
    return (
      <div className="fixed inset-0 z-50">
        <Model3DViewer
          modelUrl={completedModel.modelUrl}
          onClose={() => navigate(-1)}
        />
        
        {/* New scan button overlay */}
        <button
          onClick={handleNewScan}
          className="absolute bottom-24 left-1/2 transform -translate-x-1/2 px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors shadow-lg"
        >
          Scan Another Room
        </button>
      </div>
    );
  }

  // If on mobile and not authenticated (and no token being validated), show error
  if (isMobile && !isAuthenticated && !tokenValidating && !mobileToken) {
    return (
      <div className="fixed inset-0 bg-gray-900 z-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl p-8 max-w-md w-full text-center">
          <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Authentication Required</h2>
          <p className="text-gray-600 mb-6">
            Please scan a QR code from the desktop app to access the room scanner.
          </p>
          <p className="text-sm text-gray-500">
            Open the Renovations page on your desktop and click "Scan with Phone" to get a secure QR code.
          </p>
        </div>
      </div>
    );
  }

  // Show cubemap viewer for completed cubemap scan
  if (selectedCubemap) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading room view...</p>
          </div>
        </div>
      }>
        <CubemapViewer
          faces={selectedCubemap.faces}
          depthMaps={depthMaps || undefined}
          roomName={selectedCubemap.name}
          onClose={() => {
            setSelectedCubemap(null);
            setDepthMaps(null);
          }}
          enableGyroscope={isMobile}
          enableDepth={!!depthMaps && Object.keys(depthMaps).length > 0}
          onRequestDepth={() => processDepthMaps(selectedCubemap.faces)}
        />
        
        {/* Depth processing overlay */}
        {isProcessingDepth && (
          <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center">
            <div className="text-center text-white">
              <div className="relative w-24 h-24 mx-auto mb-4">
                <svg className="w-24 h-24 transform -rotate-90" viewBox="0 0 100 100">
                  <circle
                    className="text-white/20"
                    strokeWidth="6"
                    stroke="currentColor"
                    fill="transparent"
                    r="42"
                    cx="50"
                    cy="50"
                  />
                  <circle
                    className="text-blue-500"
                    strokeWidth="6"
                    strokeLinecap="round"
                    stroke="currentColor"
                    fill="transparent"
                    r="42"
                    cx="50"
                    cy="50"
                    strokeDasharray={`${depthProgress * 2.64} 264`}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-xl font-bold">
                  {depthProgress}%
                </span>
              </div>
              <p className="text-lg font-medium">Processing Depth Maps...</p>
              <p className="text-sm text-white/60 mt-2">Using AI to create 3D depth effect</p>
            </div>
          </div>
        )}
        
        {/* Add 3D button */}
        {!depthMaps && !isProcessingDepth && (
          <button
            onClick={() => processDepthMaps(selectedCubemap.faces)}
            className="fixed bottom-20 left-1/2 transform -translate-x-1/2 z-[55] px-6 py-3 bg-gradient-to-r from-purple-600 to-blue-600 text-white rounded-full font-medium shadow-lg hover:shadow-xl transition-all flex items-center gap-2"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" />
            </svg>
            Add 3D Depth Effect
          </button>
        )}
        
        {/* Depth enabled indicator */}
        {depthMaps && Object.keys(depthMaps).length > 0 && !isProcessingDepth && (
          <div className="fixed bottom-20 left-1/2 transform -translate-x-1/2 z-[55] px-4 py-2 bg-green-600/90 text-white rounded-full text-sm font-medium flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            3D Depth Active ({Object.keys(depthMaps).length}/6 faces)
          </div>
        )}
      </React.Suspense>
    );
  }

  // Show cubemap scanner (new default)
  if (showCubemapScanner) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading scanner...</p>
          </div>
        </div>
      }>
        <CubemapScanner
          roomName={roomName}
          onComplete={handleCubemapComplete}
          onCancel={() => {
            setShowCubemapScanner(false);
            fetchSavedScans();
          }}
        />
      </React.Suspense>
    );
  }

  // Show depth processing overlay
  if (isProcessingDepth) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="text-white text-center max-w-md px-6">
          <div className="mb-6">
            <svg className="w-20 h-20 mx-auto mb-4" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="45" fill="none" stroke="#1f2937" strokeWidth="8"/>
              <circle 
                cx="50" 
                cy="50" 
                r="45" 
                fill="none" 
                stroke="#3b82f6" 
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 45}`}
                strokeDashoffset={`${2 * Math.PI * 45 * (1 - depthProgress / 100)}`}
                transform="rotate(-90 50 50)"
                className="transition-all duration-300"
              />
              <text x="50" y="55" textAnchor="middle" fill="white" fontSize="20" fontWeight="bold">
                {depthProgress}%
              </text>
            </svg>
          </div>
          <h2 className="text-2xl font-bold mb-2">Processing 3D Room Scan</h2>
          <p className="text-gray-300 mb-4">
            {processingMessage}
          </p>
          <div className="flex items-center justify-center gap-2 text-sm text-gray-400">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            <span>Using ZoeDepth AI + image stitching</span>
          </div>
        </div>
      </div>
    );
  }

  // Show immersive spherical panorama viewer (new 26-photo stitched result)
  if (stitchedPanorama) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading immersive viewer...</p>
          </div>
        </div>
      }>
        <SphericalPanoramaViewer
          equirectangular={stitchedPanorama.equirectangular}
          depthPanorama={stitchedPanorama.depthPanorama?.data}
          depthMetadata={stitchedPanorama.depthPanorama ? {
            minDepth: stitchedPanorama.depthPanorama.minDepth,
            maxDepth: stitchedPanorama.depthPanorama.maxDepth,
            width: stitchedPanorama.depthPanorama.width,
            height: stitchedPanorama.depthPanorama.height
          } : undefined}
          pointCloud={stitchedPanorama.pointCloud}
          pointCloudFile={stitchedPanorama.pointCloudFile}
          roomDimensions={stitchedPanorama.roomDimensions}
          onClose={() => setStitchedPanorama(null)}
        />
      </React.Suspense>
    );
  }

  // Show auto panorama scanner (smart auto-capture)
  if (showAutoPanoramaScanner) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading smart scanner...</p>
          </div>
        </div>
      }>
        <AutoPanoramaScanner
          roomName={roomName}
          onComplete={handlePanoramaComplete}
          onCancel={() => {
            setShowAutoPanoramaScanner(false);
            fetchSavedScans();
          }}
          targetCoverage={90}
        />
      </React.Suspense>
    );
  }

  // Show panorama scanner (manual 26-photo capture)
  if (showPanoramaScanner) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading panorama scanner...</p>
          </div>
        </div>
      }>
        <PanoramaScanner
          roomName={roomName}
          onComplete={handlePanoramaComplete}
          onCancel={() => {
            setShowPanoramaScanner(false);
            fetchSavedScans();
          }}
        />
      </React.Suspense>
    );
  }

  // Show Live Renovation Scanner (AI-guided renovation assessment)
  if (showLiveRenovationScanner) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading AI Renovation Scanner...</p>
          </div>
        </div>
      }>
        <LiveRenovationScanner
          roomName={renovationRoomName || roomName}
          roomType={renovationRoomType}
          propertyId={propertyId}
          address={renovationAddress}
          zipCode={renovationZipCode}
          onComplete={(session) => {
            console.log('[RoomScannerPage] Live renovation scan complete:', session);
            setShowLiveRenovationScanner(false);
            // Navigate to results page with session data
            navigate('/renovation-results', { state: { session } });
          }}
          onCancel={() => {
            setShowLiveRenovationScanner(false);
          }}
        />
      </React.Suspense>
    );
  }

  // Show Live Renovation Setup Modal (get address, room type before scanning)
  if (showLiveRenovationSetup) {
    const detectLocation = async () => {
      setIsDetectingLocation(true);
      setLocationError(null);
      
      try {
        // Check if geolocation is supported
        if (!navigator.geolocation) {
          throw new Error('Geolocation is not supported by your browser');
        }
        
        // Check if we're in a secure context (HTTPS)
        if (!window.isSecureContext) {
          throw new Error('Location requires a secure connection (HTTPS)');
        }
        
        console.log('[Location] Requesting geolocation permission...');
        
        // Request geolocation permission - this should trigger the browser prompt
        const position = await new Promise<GeolocationPosition>((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              console.log('[Location] Permission granted, got position');
              resolve(pos);
            },
            (err) => {
              console.log('[Location] Geolocation error:', err.code, err.message);
              reject(err);
            },
            {
              enableHighAccuracy: true,
              timeout: 15000,  // Increased timeout for permission prompt
              maximumAge: 60000  // Accept cached position up to 1 minute old
            }
          );
        });
        
        const { latitude, longitude } = position.coords;
        console.log('[Location] Got coordinates:', latitude, longitude);
        
        // Use Google Geocoding API to get address
        const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || import.meta.env.VITE_GOOGLE_API_KEY;
        if (!apiKey) {
          throw new Error('Google Maps API key not configured');
        }
        
        const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${apiKey}`;
        const response = await fetch(geocodeUrl);
        const data = await response.json();
        
        if (data.status === 'OK' && data.results && data.results.length > 0) {
          const result = data.results[0];
          const formattedAddress = result.formatted_address;
          
          // Extract zip code from address components
          const zipComponent = result.address_components?.find(
            (comp: any) => comp.types.includes('postal_code')
          );
          const zip = zipComponent?.long_name || '';
          
          setRenovationAddress(formattedAddress);
          setRenovationZipCode(zip);
          console.log('[Location] Detected address:', formattedAddress, 'ZIP:', zip);
        } else {
          throw new Error('Could not determine address from location');
        }
      } catch (err: any) {
        console.error('[Location] Error:', err);
        
        // Handle GeolocationPositionError
        if (err.code !== undefined) {
          switch (err.code) {
            case 1: // PERMISSION_DENIED
              // Check if iOS Safari
              const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
              const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
              if (isIOS) {
                setLocationError('Location access denied. On iOS: Go to Settings > Safari > Location and allow for this site, or Settings > Privacy > Location Services > Safari Websites.');
              } else if (isSafari) {
                setLocationError('Location access denied. In Safari: Go to Preferences > Websites > Location and allow for this site.');
              } else {
                setLocationError('Location access denied. Click the lock icon in your browser address bar to enable location, or enter the address manually.');
              }
              break;
            case 2: // POSITION_UNAVAILABLE
              setLocationError('Could not determine your location. Please try again or enter the address manually.');
              break;
            case 3: // TIMEOUT
              setLocationError('Location request timed out. Please try again or enter the address manually.');
              break;
            default:
              setLocationError('Location error. Please enter the address manually.');
          }
        } else {
          setLocationError(err.message || 'Could not detect location. Please enter manually.');
        }
      } finally {
        setIsDetectingLocation(false);
      }
    };

    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
          <h2 className="text-2xl font-bold text-gray-900 mb-2 text-center">🏠 Property Details</h2>
          <p className="text-gray-500 text-center mb-6">Help us provide accurate cost estimates for your area</p>
          
          {/* Location Detection */}
          <div className="mb-6">
            <button
              onClick={detectLocation}
              disabled={isDetectingLocation}
              className="w-full py-3 px-4 bg-blue-500 text-white rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-blue-600 disabled:bg-blue-300 transition-colors"
            >
              {isDetectingLocation ? (
                <>
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Detecting Location...
                </>
              ) : (
                <>
                  📍 Auto-Detect My Location
                </>
              )}
            </button>
            {locationError && (
              <p className="text-red-500 text-sm mt-2 text-center">{locationError}</p>
            )}
          </div>
          
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-gray-400 text-sm">or enter manually</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
          
          {/* Address Input */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Property Address</label>
              <input
                type="text"
                value={renovationAddress}
                onChange={(e) => setRenovationAddress(e.target.value)}
                placeholder="123 Main St, City, State"
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">ZIP Code</label>
              <input
                type="text"
                value={renovationZipCode}
                onChange={(e) => setRenovationZipCode(e.target.value)}
                placeholder="12345"
                maxLength={10}
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Room Name</label>
              <input
                type="text"
                value={renovationRoomName}
                onChange={(e) => setRenovationRoomName(e.target.value)}
                placeholder="Master Bathroom"
                className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-orange-500 focus:border-orange-500"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Room Type</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { value: 'kitchen', label: '🍳 Kitchen' },
                  { value: 'bathroom', label: '🛁 Bathroom' },
                  { value: 'bedroom', label: '🛏️ Bedroom' },
                  { value: 'living_room', label: '🛋️ Living' },
                  { value: 'basement', label: '🏚️ Basement' },
                  { value: 'other', label: '📦 Other' },
                ].map((type) => (
                  <button
                    key={type.value}
                    onClick={() => setRenovationRoomType(type.value as any)}
                    className={`py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                      renovationRoomType === type.value
                        ? 'bg-orange-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          
          {/* Action Buttons */}
          <div className="flex gap-3 mt-6">
            <button
              onClick={() => {
                setShowLiveRenovationSetup(false);
                setShowScanModeSelection(true);
              }}
              className="flex-1 py-3 px-4 border border-gray-300 rounded-xl text-gray-700 font-medium hover:bg-gray-50"
            >
              Back
            </button>
            <button
              onClick={() => {
                setShowLiveRenovationSetup(false);
                // Navigate to the unified photogrammetry scanner in AI renovation mode
                const params = new URLSearchParams();
                if (propertyId) params.set('propertyId', propertyId);
                params.set('room', renovationRoomName || roomName);
                params.set('purpose', 'ai-renovation');
                params.set('roomType', renovationRoomType);
                if (renovationAddress) params.set('address', renovationAddress);
                if (renovationZipCode) params.set('zipCode', renovationZipCode);
                if (mobileToken) params.set('token', mobileToken);
                navigate(`/photogrammetry-scan?${params.toString()}`);
              }}
              className="flex-1 py-3 px-4 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700"
            >
              Start AI Scan ✨
            </button>
          </div>
          
          <p className="text-xs text-gray-400 text-center mt-4">
            Location data is used for accurate local pricing. Skip if you prefer generic estimates.
          </p>
        </div>
      </div>
    );
  }

  // Show scan mode selection modal
  if (showScanModeSelection) {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto">
          <h2 className="text-2xl font-bold text-gray-900 mb-2 text-center">Choose Scan Mode</h2>
          <p className="text-gray-500 text-center mb-6">Select how you want to capture the room</p>
          
          <div className="space-y-3">
            <button
              onClick={() => {
                setShowScanModeSelection(false);
                setShowRoomTourVideoCapture(true);
              }}
              className="w-full p-4 border-2 border-emerald-500 bg-emerald-50 rounded-xl text-left hover:bg-emerald-100 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="text-3xl">🎥</div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-gray-900">Video Home Tour</span>
                    <span className="text-xs bg-emerald-500 text-white px-2 py-0.5 rounded-full">New Pipeline</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">
                    Record a slow walkthrough video for the new GCP room-tour pipeline using MASt3R, Metric3D priors, and Gaussian splats.
                  </p>
                </div>
              </div>
            </button>

            {/* Photogrammetry Scanner - Full 3D Model OR AI Renovation */}
            <div className="border-2 border-purple-500 bg-gradient-to-br from-purple-50 to-blue-50 rounded-xl overflow-hidden">
              <div className="p-4 pb-2">
                <div className="flex items-start gap-3">
                  <div className="text-3xl">📷</div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-gray-900">Photogrammetry Scanner</span>
                      <span className="text-xs bg-purple-500 text-white px-2 py-0.5 rounded-full">Pro</span>
                    </div>
                    <p className="text-sm text-gray-600 mt-1">
                      Full sensor-based capture with position tracking, quality metrics, and AR support.
                      If you want a renovation-grade 3D room model, choose Full 3D Model. It now opens with Master v1 room-tour capture so the scan runs on the canonical GLOMAP pipeline and publishes a Gaussian viewer alongside the mesh.
                    </p>
                  </div>
                </div>
              </div>
              
              {/* Two sub-options within the photogrammetry scanner */}
              <div className="grid grid-cols-2 gap-2 p-3 pt-1">
                {/* Full 3D Model */}
                <button
                  onClick={() => {
                    setShowScanModeSelection(false);
                    const params = new URLSearchParams();
                    if (propertyId) params.set('propertyId', propertyId);
                    params.set('room', roomName);
                    params.set('purpose', 'full-3d');
                    params.set('pipeline', 'master_v1');
                    params.set('captureMode', 'room_tour');
                    if (mobileToken) params.set('token', mobileToken);
                    navigate(`/photogrammetry-scan?${params.toString()}`);
                  }}
                  className="p-3 bg-blue-100 hover:bg-blue-200 rounded-lg text-left transition-colors border border-blue-300"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="text-xl">🏗️</div>
                    <span className="rounded-full bg-cyan-600 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-white">Gaussian default</span>
                  </div>
                  <div className="font-bold text-sm text-gray-900">Full 3D Model</div>
                  <p className="text-xs text-gray-600 mt-1">
                    Opens Master v1 with Gaussian Splat selected by default. Dense Mesh remains available inside the scanner output selector.
                  </p>
                </button>
                
                {/* AI Renovation Analysis */}
                <button
                  onClick={() => {
                    setShowScanModeSelection(false);
                    setShowLiveRenovationSetup(true);
                  }}
                  className="p-3 bg-purple-100 hover:bg-purple-200 rounded-lg text-left transition-colors border border-purple-300"
                >
                  <div className="text-xl mb-1">✨</div>
                  <div className="font-bold text-sm text-gray-900">AI Renovation</div>
                  <p className="text-xs text-gray-600 mt-1">
                    Quick capture for ROI analysis, cost estimates & preview rendering
                  </p>
                </button>
              </div>
            </div>
            
            {/* Auto Scan - Recommended */}
            <button
              onClick={() => {
                setShowScanModeSelection(false);
                setShowAutoPanoramaScanner(true);
              }}
              className="w-full p-4 border-2 border-blue-500 bg-blue-50 rounded-xl text-left hover:bg-blue-100 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="text-3xl">🤖</div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-gray-900">Smart Auto-Scan</span>
                    <span className="text-xs bg-blue-500 text-white px-2 py-0.5 rounded-full">Recommended</span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">
                    Pan your phone around - photos captured automatically. 
                    Shows coverage % and guides you to missed areas.
                  </p>
                </div>
              </div>
            </button>
            
            {/* Manual 26-photo */}
            <button
              onClick={() => {
                setShowScanModeSelection(false);
                setShowPanoramaScanner(true);
              }}
              className="w-full p-4 border border-gray-200 rounded-xl text-left hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="text-3xl">📸</div>
                <div>
                  <span className="font-bold text-gray-900">Manual Pro Scan</span>
                  <p className="text-sm text-gray-600 mt-1">
                    Follow guided 26-photo sequence for maximum quality. 
                    Best for detailed room documentation.
                  </p>
                </div>
              </div>
            </button>
            
            {/* Quick 6-photo */}
            <button
              onClick={() => {
                setShowScanModeSelection(false);
                setShowCubemapScanner(true);
              }}
              className="w-full p-4 border border-gray-200 rounded-xl text-left hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="text-3xl">⚡</div>
                <div>
                  <span className="font-bold text-gray-900">Quick Scan</span>
                  <p className="text-sm text-gray-600 mt-1">
                    Just 6 photos - front, back, left, right, up, down. 
                    Fastest option for basic room view.
                  </p>
                </div>
              </div>
            </button>
          </div>
          
          <button
            onClick={() => setShowScanModeSelection(false)}
            className="w-full mt-4 py-3 text-gray-500 hover:text-gray-700 text-sm"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Show sphere viewer for panorama
  if (selectedPanorama) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading panorama...</p>
          </div>
        </div>
      }>
        <SphereViewer
          photos={selectedPanorama.photos}
          roomName={selectedPanorama.name}
          onClose={() => setSelectedPanorama(null)}
          enableGyroscope={isMobile}
          enableDepth={true}
        />
      </React.Suspense>
    );
  }

  // Show old scanner (legacy)
  if (showScanner) {
    return (
      <React.Suspense fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
          <div className="text-white text-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p>Loading scanner...</p>
          </div>
        </div>
      }>
        <RoomScanner
          propertyId={propertyId}
          roomName={roomName}
          onComplete={handleComplete}
          onCancel={() => {
          setShowScanner(false);
          // Refresh saved scans list
          listSavedScans({ propertyId }).then(result => {
            if (result.success && result.scans) {
              setSavedScans(result.scans);
            }
          });
        }}
      />
      </React.Suspense>
    );
  }

  // Main page - Saved Scans Gallery with option to start new scan
  return (
    <div className="min-h-screen bg-gray-100" data-voice-id="room-scanner-page">
      {/* VERSION BADGE - CONFIRMS NEW CODE IS LOADED */}
      <div className="fixed top-2 right-2 bg-red-600 text-white px-3 py-1 rounded-full text-xs font-bold z-50">
        PAGE v2025-12-02_17:10
      </div>
      
      {/* Header */}
      <div className="bg-white border-b shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate(-1)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div>
                <h1 className="text-xl font-bold text-gray-900">3D Room Scanner</h1>
                <p className="text-sm text-gray-500">Take 6 photos to create a 360° room view</p>
              </div>
            </div>
            
            <button
              onClick={() => {
                if (isMobile) {
                  // On mobile, show scan mode selection modal
                  setShowScanModeSelection(true);
                } else {
                  setShowDesktopPrompt(true);
                }
              }}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors flex items-center gap-2"
              data-voice-id="new-room-scan-btn"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Scan
            </button>

            <button
              onClick={() => setShowUploadOption(true)}
              className="px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors flex items-center gap-2"
              data-voice-id="upload-room-photos-btn"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
              Upload Photos
            </button>
          </div>
        </div>
      </div>

      {/* QR Code for mobile scanning (desktop only) */}
      {!isMobile && ngrokUrl && (
        <div className="bg-blue-50 border-b border-blue-200">
          <div className="max-w-6xl mx-auto px-4 py-4">
            <div className="flex items-center gap-6">
              <div className="bg-white p-3 rounded-lg shadow-sm">
                <QRCodeSVG value={ngrokUrl} size={80} level="M" />
              </div>
              <div>
                <h3 className="font-medium text-blue-900">Scan with your iPhone</h3>
                <p className="text-sm text-blue-700">For the best scanning experience, use your phone's camera</p>
                <p className="text-xs text-blue-600 mt-1 font-mono truncate max-w-md">{ngrokUrl}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Saved Scans Gallery */}
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-900">
            Saved Room Scans
            {savedScans.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">({savedScans.length})</span>
            )}
          </h2>
        </div>

        {latestRoomTourJob && (
          <div className="mb-6 bg-white border border-emerald-200 rounded-2xl p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-gray-900">
                  {latestRoomTourJob.status === 'completed' ? 'Video room tour completed' : 'Video room tour processing'}
                </h3>
                <p className="text-sm text-gray-600 mt-1">
                  Job {latestRoomTourJob.id} is running through the video-to-3D pipeline.
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  Primary output: {latestRoomTourJob.primaryOutput} · Status: {latestRoomTourJob.status}
                </p>
                {latestRoomTourJob.capture?.selectedKeyframeCount ? (
                  <p className="text-xs text-gray-500 mt-1">
                    Selected keyframes: {latestRoomTourJob.capture.selectedKeyframeCount}
                    {latestRoomTourJob.capture.extractedFrameCount ? ` / ${latestRoomTourJob.capture.extractedFrameCount} extracted` : ''}
                  </p>
                ) : null}
                {latestRoomTourJob.outputs?.modelViewerUrl ? (
                  <p className="text-xs text-emerald-700 mt-2">
                    Separate viewer ready: {latestRoomTourJob.outputs.modelViewerUrl}
                  </p>
                ) : null}
                {typeof latestRoomTourJob.metadata?.['lastError'] === 'string' ? (
                  <p className="text-xs text-red-600 mt-2">
                    {latestRoomTourJob.metadata['lastError'] as string}
                  </p>
                ) : null}
                <div className="flex items-center gap-3 mt-4 flex-wrap">
                  {latestRoomTourJob.outputs?.modelViewerUrl ? (
                    <button
                      onClick={() => navigate(latestRoomTourJob.outputs?.modelViewerUrl || `/room-tour-view/${latestRoomTourJob.id}`)}
                      className="px-4 py-2 rounded-full bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-colors"
                    >
                      Open Room Tour
                    </button>
                  ) : null}
                  <button
                    onClick={fetchSavedScans}
                    className="px-4 py-2 rounded-full bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 transition-colors"
                  >
                    Refresh Saved Scans
                  </button>
                </div>
              </div>
              <button
                onClick={() => setLatestRoomTourJob(null)}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {loadingScans ? (
          <div className="flex items-center justify-center py-12">
            <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        ) : savedScans.length === 0 ? (
          <div className="text-center py-12 bg-white rounded-xl border-2 border-dashed border-gray-300">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No Room Scans Yet</h3>
            <p className="text-gray-500 mb-6 max-w-sm mx-auto">
              Start by scanning a room with your phone to create an immersive 3D view.
            </p>
            <button
              onClick={() => {
                if (isMobile) {
                  setShowScanModeSelection(true);
                } else {
                  setShowDesktopPrompt(true);
                }
              }}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors inline-flex items-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              </svg>
              Start Scanning
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {savedScans.map(scan => (
              <div
                key={scan.id}
                className="bg-white rounded-xl overflow-hidden shadow-sm border hover:shadow-md transition-shadow"
              >
                {/* Thumbnail */}
                <div className="aspect-video bg-gray-100 relative">
                  <img
                    src={getScanThumbnailUrl(scan.id)}
                    alt={scan.roomName}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23ccc"><path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/></svg>';
                    }}
                  />
                  
                  {/* Scan Type Badge */}
                  <div className="absolute top-2 left-2">
                    {((scan as any).type === 'photogrammetry' || (scan as any).metadata?.scanType === 'photogrammetry') ? (
                      <span className="px-2 py-1 bg-emerald-500/90 text-white text-xs font-medium rounded-full flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 3.5a1.5 1.5 0 013 0V4a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-.5a1.5 1.5 0 000 3h.5a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-.5a1.5 1.5 0 00-3 0v.5a1 1 0 01-1 1H6a1 1 0 01-1-1v-3a1 1 0 00-1-1h-.5a1.5 1.5 0 010-3H4a1 1 0 001-1V6a1 1 0 011-1h3a1 1 0 001-1v-.5z" />
                        </svg>
                        3D Photogrammetry
                      </span>
                    ) : (scan as any).metadata?.scanType === 'spherical_panorama' ? (
                      <span className="px-2 py-1 bg-purple-500/90 text-white text-xs font-medium rounded-full flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.012 6.012 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V8a2 2 0 004 0 2 2 0 011.523-1.943A5.977 5.977 0 0116 10c0 .34-.028.675-.083 1H15a2 2 0 00-2 2v2.197A5.973 5.973 0 0110 16v-2a2 2 0 00-2-2 2 2 0 01-2-2 2 2 0 00-1.668-1.973z" />
                        </svg>
                        360° Panorama
                      </span>
                    ) : (scan as any).metadata?.scanType === 'cubemap' ? (
                      <span className="px-2 py-1 bg-blue-500/90 text-white text-xs font-medium rounded-full flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6zM14 9a1 1 0 00-1 1v6a1 1 0 001 1h2a1 1 0 001-1v-6a1 1 0 00-1-1h-2z" />
                        </svg>
                        Cubemap 6-Shot
                      </span>
                    ) : (
                      <span className="px-2 py-1 bg-gray-500/90 text-white text-xs font-medium rounded-full">
                        Legacy Scan
                      </span>
                    )}
                  </div>
                  
                  {/* Room Dimensions Badge (if available) */}
                  {(scan as any).metadata?.roomDimensions && (
                    <div className="absolute top-2 right-2">
                      <span className="px-2 py-1 bg-green-500/90 text-white text-xs font-medium rounded-full flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M3 4a1 1 0 011-1h4a1 1 0 010 2H6.414l2.293 2.293a1 1 0 01-1.414 1.414L5 6.414V8a1 1 0 01-2 0V4zm9 1a1 1 0 010-2h4a1 1 0 011 1v4a1 1 0 01-2 0V6.414l-2.293 2.293a1 1 0 11-1.414-1.414L13.586 5H12zm-9 7a1 1 0 012 0v1.586l2.293-2.293a1 1 0 011.414 1.414L6.414 15H8a1 1 0 010 2H4a1 1 0 01-1-1v-4zm13-1a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 010-2h1.586l-2.293-2.293a1 1 0 011.414-1.414L15 13.586V12a1 1 0 011-1z" clipRule="evenodd" />
                        </svg>
                        Measured
                      </span>
                    </div>
                  )}
                  
                  {loadingScanId === scan.id && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                </div>
                
                {/* Info */}
                <div className="p-4">
                  <h3 className="font-semibold text-gray-900 mb-1">{scan.roomName}</h3>
                  <div className="flex items-center gap-3 text-sm text-gray-500 mb-2">
                    <span>{scan.frameCount} frames</span>
                    <span>•</span>
                    <span>{formatSavedScanTimestamp(scan.createdAt)}</span>
                  </div>
                  
                  {/* Room Dimensions Display */}
                  {(scan as any).metadata?.roomDimensions && (
                    <div className="text-xs text-gray-600 mb-3 bg-gray-50 p-2 rounded">
                      <div className="font-medium text-gray-700 mb-1">📐 Dimensions:</div>
                      <div className="grid grid-cols-2 gap-1">
                        <span>{(scan as any).metadata.roomDimensions.widthFeet?.toFixed(1)} ft × {(scan as any).metadata.roomDimensions.lengthFeet?.toFixed(1)} ft</span>
                        <span className="text-right">{(scan as any).metadata.roomDimensions.floorAreaSqFt} sq ft</span>
                      </div>
                    </div>
                  )}
                  
                  {/* Photogrammetry 3D Model Info */}
                  {((scan as any).type === 'photogrammetry' || (scan as any).metadata?.scanType === 'photogrammetry') && (scan as any).metadata?.processingResult && (
                    <div className="text-xs text-gray-600 mb-3 bg-emerald-50 p-2 rounded border border-emerald-200">
                      <div className="font-medium text-emerald-700 mb-1 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 3.5a1.5 1.5 0 013 0V4a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-.5a1.5 1.5 0 000 3h.5a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-.5a1.5 1.5 0 00-3 0v.5a1 1 0 01-1 1H6a1 1 0 01-1-1v-3a1 1 0 00-1-1h-.5a1.5 1.5 0 010-3H4a1 1 0 001-1V6a1 1 0 011-1h3a1 1 0 001-1v-.5z" />
                        </svg>
                        3D Model:
                      </div>
                      <div className="grid grid-cols-2 gap-1 text-[10px]">
                        <span>{((scan as any).metadata.processingResult.numVertices || 0).toLocaleString()} vertices</span>
                        <span className="text-right">{((scan as any).metadata.processingResult.numFaces || 0).toLocaleString()} faces</span>
                        <span>{((scan as any).metadata.processingResult.numPoints || 0).toLocaleString()} points</span>
                        {(scan as any).metadata.processingResult.numViewpoints && (
                          <span className="text-right">{(scan as any).metadata.processingResult.numViewpoints} viewpoints</span>
                        )}
                      </div>
                      {((scan as any).metadata.refGaussianMeshHybridArtifacts?.texturedObjUrl || (scan as any).metadata.modelFiles?.obj) && (
                        <div className="mt-2 text-[10px] text-cyan-700 font-medium">
                          Textured mesh available — open View and select the Textured Mesh tab
                        </div>
                      )}
                    </div>
                  )}
                  
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleViewScan(scan.id)}
                      disabled={loadingScanId === scan.id}
                      className="flex-1 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors text-sm flex items-center justify-center gap-1"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                      View
                    </button>
                    <button
                      onClick={() => handleDeleteScan(scan.id)}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RoomScannerPage;
