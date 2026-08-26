/**
 * useAIInteriorScan Hook
 * 
 * React hook for managing the AI interior scanning workflow.
 * Handles scanning, suggestion management, and preview generation.
 */

import { useState, useCallback, useRef } from 'react';
import * as THREE from 'three';
import {
  performInteriorScan,
  generateRenovationPreview,
  captureSuggestionView,
  getRenovationOptionsForType,
  type RenovationSuggestion,
  type InteriorScanResult,
} from '../services/aiInteriorScanService';

// ============================================================================
// Types
// ============================================================================

export interface UseAIInteriorScanOptions {
  onScanStart?: () => void;
  onScanProgress?: (stage: string, progress: number) => void;
  onScanComplete?: (result: InteriorScanResult) => void;
  onScanError?: (error: string) => void;
  onPreviewGenerated?: (suggestionId: string, previewImageBase64: string) => void;
}

export interface UseAIInteriorScanReturn {
  // State
  isScanning: boolean;
  scanProgress: { stage: string; progress: number } | null;
  suggestions: RenovationSuggestion[];
  selectedSuggestion: RenovationSuggestion | null;
  lastScanResult: InteriorScanResult | null;
  error: string | null;
  
  // Actions
  startScan: (
    mesh: THREE.Mesh | THREE.Group,
    scene: THREE.Scene,
    options?: {
      numViewpoints?: number;
      roomDimensions?: { width: number; length: number; height: number; unit: 'ft' | 'm' };
    }
  ) => Promise<void>;
  
  selectSuggestion: (suggestion: RenovationSuggestion | null) => void;
  
  generatePreview: (
    suggestion: RenovationSuggestion,
    mesh: THREE.Mesh | THREE.Group,
    scene: THREE.Scene,
    renovationOption?: string
  ) => Promise<void>;
  
  clearSuggestions: () => void;
  dismissSuggestion: (suggestionId: string) => void;
  
  // Helpers
  getRenovationOptions: (type: RenovationSuggestion['type']) => string[];
}

// ============================================================================
// Hook Implementation
// ============================================================================

export function useAIInteriorScan(
  options: UseAIInteriorScanOptions = {}
): UseAIInteriorScanReturn {
  const {
    onScanStart,
    onScanProgress,
    onScanComplete,
    onScanError,
    onPreviewGenerated,
  } = options;
  
  // State
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ stage: string; progress: number } | null>(null);
  const [suggestions, setSuggestions] = useState<RenovationSuggestion[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState<RenovationSuggestion | null>(null);
  const [lastScanResult, setLastScanResult] = useState<InteriorScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Track generating previews to prevent duplicates
  const generatingPreviews = useRef<Set<string>>(new Set());
  
  // Start AI interior scan
  const startScan = useCallback(async (
    mesh: THREE.Mesh | THREE.Group,
    scene: THREE.Scene,
    scanOptions?: {
      numViewpoints?: number;
      roomDimensions?: { width: number; length: number; height: number; unit: 'ft' | 'm' };
    }
  ) => {
    if (isScanning) {
      console.warn('[useAIInteriorScan] Scan already in progress');
      return;
    }
    
    console.log('[useAIInteriorScan] Starting AI interior scan...');
    setIsScanning(true);
    setError(null);
    setScanProgress({ stage: 'Starting scan', progress: 0 });
    onScanStart?.();
    
    try {
      const result = await performInteriorScan(mesh, scene, {
        numViewpoints: scanOptions?.numViewpoints || 12,
        roomDimensions: scanOptions?.roomDimensions,
        onProgress: (stage, progress) => {
          setScanProgress({ stage, progress });
          onScanProgress?.(stage, progress);
        },
      });
      
      setLastScanResult(result);
      
      if (result.success) {
        console.log(`[useAIInteriorScan] Scan complete: ${result.suggestions.length} suggestions found`);
        setSuggestions(result.suggestions);
        onScanComplete?.(result);
      } else {
        const errorMsg = result.error || 'Scan failed';
        console.error('[useAIInteriorScan] Scan failed:', errorMsg);
        setError(errorMsg);
        onScanError?.(errorMsg);
      }
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error during scan';
      console.error('[useAIInteriorScan] Scan error:', err);
      setError(errorMsg);
      onScanError?.(errorMsg);
    } finally {
      setIsScanning(false);
      setScanProgress(null);
    }
  }, [isScanning, onScanStart, onScanProgress, onScanComplete, onScanError]);
  
  // Select a suggestion
  const selectSuggestion = useCallback((suggestion: RenovationSuggestion | null) => {
    setSelectedSuggestion(suggestion);
  }, []);
  
  // Generate preview for a suggestion
  const generatePreview = useCallback(async (
    suggestion: RenovationSuggestion,
    mesh: THREE.Mesh | THREE.Group,
    scene: THREE.Scene,
    renovationOption?: string
  ) => {
    // Prevent duplicate generation
    if (generatingPreviews.current.has(suggestion.id)) {
      console.warn('[useAIInteriorScan] Preview already generating for:', suggestion.id);
      return;
    }
    
    console.log('[useAIInteriorScan] Generating preview for:', suggestion.title);
    generatingPreviews.current.add(suggestion.id);
    
    // Update suggestion state to show loading
    setSuggestions(prev => prev.map(s => 
      s.id === suggestion.id 
        ? { ...s, previewGenerating: true, previewError: undefined }
        : s
    ));
    
    try {
      // Capture the view from the suggestion's camera position
      const capturedImage = captureSuggestionView(mesh, scene, suggestion);
      
      // Update suggestion with captured image
      setSuggestions(prev => prev.map(s =>
        s.id === suggestion.id
          ? { ...s, capturedImageBase64: capturedImage }
          : s
      ));
      
      // Generate the renovation preview
      const result = await generateRenovationPreview({
        suggestionId: suggestion.id,
        capturedImageBase64: capturedImage,
        renovationType: suggestion.suggestedRenovation.renovationType,
        renovationOption: renovationOption || suggestion.suggestedRenovation.renovationOption,
      });
      
      if (result.success && result.previewImageBase64) {
        console.log('[useAIInteriorScan] Preview generated successfully');
        
        setSuggestions(prev => prev.map(s =>
          s.id === suggestion.id
            ? { 
                ...s, 
                previewImageBase64: result.previewImageBase64,
                previewGenerating: false,
              }
            : s
        ));
        
        // Also update selected suggestion if it's the same
        setSelectedSuggestion(prev => 
          prev?.id === suggestion.id
            ? { 
                ...prev, 
                previewImageBase64: result.previewImageBase64,
                capturedImageBase64: capturedImage,
                previewGenerating: false,
              }
            : prev
        );
        
        onPreviewGenerated?.(suggestion.id, result.previewImageBase64);
      } else {
        throw new Error(result.error || 'Failed to generate preview');
      }
    } catch (err: any) {
      console.error('[useAIInteriorScan] Preview generation error:', err);
      
      setSuggestions(prev => prev.map(s =>
        s.id === suggestion.id
          ? { ...s, previewGenerating: false, previewError: err.message }
          : s
      ));
      
      setSelectedSuggestion(prev =>
        prev?.id === suggestion.id
          ? { ...prev, previewGenerating: false, previewError: err.message }
          : prev
      );
    } finally {
      generatingPreviews.current.delete(suggestion.id);
    }
  }, [onPreviewGenerated]);
  
  // Clear all suggestions
  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    setSelectedSuggestion(null);
    setLastScanResult(null);
    setError(null);
  }, []);
  
  // Dismiss a single suggestion
  const dismissSuggestion = useCallback((suggestionId: string) => {
    setSuggestions(prev => prev.filter(s => s.id !== suggestionId));
    setSelectedSuggestion(prev => prev?.id === suggestionId ? null : prev);
  }, []);
  
  // Get renovation options for a type
  const getRenovationOptions = useCallback((type: RenovationSuggestion['type']): string[] => {
    return getRenovationOptionsForType(type);
  }, []);
  
  return {
    // State
    isScanning,
    scanProgress,
    suggestions,
    selectedSuggestion,
    lastScanResult,
    error,
    
    // Actions
    startScan,
    selectSuggestion,
    generatePreview,
    clearSuggestions,
    dismissSuggestion,
    
    // Helpers
    getRenovationOptions,
  };
}

export default useAIInteriorScan;
