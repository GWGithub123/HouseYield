/**
 * Meshy Object Generator Panel
 * 
 * UI for generating 3D objects from text prompts using Meshy AI:
 * - Browse furniture presets by category
 * - Enter custom prompts
 * - Capture viewport to generate from image
 * - Track generation progress
 * - View and manage object library
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  generateObject,
  getObjectLibrary,
  deleteFromLibrary,
  getActiveTasks,
  FURNITURE_PRESETS,
  type GeneratedObject,
  type TextTo3DTaskStatus,
} from '../services/meshyTextTo3DService';
import ViewpointCapture from './ViewpointCapture';
import ConceptTo3DPanel from './ConceptTo3DPanel';
import RenovationPlannerPanel from './RenovationPlannerPanel';
import type { Dimensions } from '../services/renovationPlannerService';

type FurnitureCategory = keyof typeof FURNITURE_PRESETS;
type GeneratorMode = 'presets' | 'viewport' | 'concept' | 'renovation';

interface ObjectGeneratorPanelProps {
  onObjectGenerated?: (objectUrl: string, thumbnailUrl?: string) => void;
  onObjectSelected?: (objectUrl: string) => void;
  onClose?: () => void;
  /** Function to capture the current viewport - must be provided for viewport mode */
  onCaptureViewport?: () => string | null;
}

export const ObjectGeneratorPanel: React.FC<ObjectGeneratorPanelProps> = ({
  onObjectGenerated,
  onObjectSelected,
  onClose,
  onCaptureViewport,
}) => {
  // Mode state - presets vs viewport capture
  const [mode, setMode] = useState<GeneratorMode>('presets');
  
  // Generation state
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStage, setGenerationStage] = useState('');
  const [generationProgress, setGenerationProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  // Form state
  const [activeCategory, setActiveCategory] = useState<FurnitureCategory>('seating');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState('');
  const [artStyle, setArtStyle] = useState<'realistic' | 'sculpture'>('realistic');
  
  // Library state
  const [showLibrary, setShowLibrary] = useState(false);
  const [library, setLibrary] = useState<GeneratedObject[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  
  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [polyCount, setPolyCount] = useState(30000);
  const [enablePBR, setEnablePBR] = useState(true);
  
  // Load library on mount
  useEffect(() => {
    loadLibrary();
  }, []);
  
  const loadLibrary = async () => {
    setLoadingLibrary(true);
    try {
      const result = await getObjectLibrary();
      if (result.success) {
        setLibrary(result.objects);
      }
    } catch (e) {
      console.error('[ObjectGenerator] Failed to load library:', e);
    } finally {
      setLoadingLibrary(false);
    }
  };
  
  // Get the effective prompt
  const getEffectivePrompt = useCallback(() => {
    if (customPrompt.trim()) {
      return customPrompt.trim();
    }
    if (selectedPreset) {
      const presets = FURNITURE_PRESETS[activeCategory];
      const preset = presets.find(p => p.name === selectedPreset);
      return preset?.prompt || '';
    }
    return '';
  }, [customPrompt, selectedPreset, activeCategory]);
  
  // Handle generation
  const handleGenerate = useCallback(async () => {
    const prompt = getEffectivePrompt();
    if (!prompt) {
      setError('Please enter a prompt or select a preset');
      return;
    }
    
    setIsGenerating(true);
    setError(null);
    setGenerationStage('Starting...');
    setGenerationProgress(0);
    
    try {
      const result = await generateObject(prompt, {
        previewOptions: {
          artStyle,
          targetPolycount: polyCount,
        },
        refineOptions: {
          enablePBR,
        },
        onProgress: (stage, progress) => {
          setGenerationStage(stage);
          setGenerationProgress(progress);
        },
      });
      
      if (result.success && result.localUrl) {
        setGenerationStage('✅ Generation complete!');
        setGenerationProgress(100);
        
        // Refresh library
        await loadLibrary();
        
        // Notify parent
        onObjectGenerated?.(result.localUrl, result.thumbnailUrl || undefined);
      } else {
        throw new Error(result.error || 'Generation failed');
      }
      
    } catch (e: any) {
      console.error('[ObjectGenerator] Error:', e);
      setError(e.message || 'Unknown error occurred');
      setGenerationStage('');
    } finally {
      setIsGenerating(false);
    }
  }, [getEffectivePrompt, artStyle, polyCount, enablePBR, onObjectGenerated]);
  
  // Handle library item selection
  const handleSelectFromLibrary = useCallback((item: GeneratedObject) => {
    onObjectSelected?.(item.url);
    setShowLibrary(false);
  }, [onObjectSelected]);
  
  // Handle library item deletion
  const handleDeleteFromLibrary = useCallback(async (item: GeneratedObject) => {
    if (!confirm(`Delete "${item.filename}"?`)) return;
    
    try {
      await deleteFromLibrary(item.filename);
      await loadLibrary();
    } catch (e) {
      console.error('[ObjectGenerator] Failed to delete:', e);
    }
  }, []);
  
  // Category icons
  const categoryIcons: Record<FurnitureCategory, string> = {
    seating: '🛋️',
    tables: '🪑',
    storage: '📦',
    lighting: '💡',
    decor: '🌿',
    kitchen: '🍳',
    bathroom: '🚿',
  };
  
  return (
    <div className="bg-gray-900 text-white p-4 rounded-lg max-w-md w-full max-h-[80vh] overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🪄</span>
          <h2 className="text-lg font-bold">AI Object Generator</h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowLibrary(!showLibrary)}
            className={`p-2 rounded transition-colors ${showLibrary ? 'bg-blue-600' : 'hover:bg-gray-700'}`}
            title="Object Library"
          >
            📁
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-2 hover:bg-gray-700 rounded transition-colors"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      
      {/* Mode Tabs - Text vs Viewport vs Concept */}
      <div className="flex gap-1 mb-4 bg-gray-800 p-1 rounded-lg">
        <button
          onClick={() => setMode('presets')}
          disabled={isGenerating}
          className={`flex-1 py-2 px-2 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
            mode === 'presets'
              ? 'bg-blue-600 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-700'
          } ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span>✍️</span>
          <span>Text</span>
        </button>
        <button
          onClick={() => setMode('concept')}
          disabled={isGenerating}
          className={`flex-1 py-2 px-2 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
            mode === 'concept'
              ? 'bg-purple-600 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-700'
          } ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
          title="Generate concept image first, then convert to 3D"
        >
          <span>🎨</span>
          <span>Concept</span>
        </button>
        <button
          onClick={() => setMode('renovation')}
          disabled={isGenerating}
          className={`flex-1 py-2 px-2 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
            mode === 'renovation'
              ? 'bg-teal-600 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-700'
          } ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
          title="Create precise 3D objects with dimensions for renovation planning"
        >
          <span>🏠</span>
          <span>Reno</span>
        </button>
        <button
          onClick={() => setMode('viewport')}
          disabled={isGenerating || !onCaptureViewport}
          className={`flex-1 py-2 px-2 rounded-md text-xs font-medium transition-colors flex items-center justify-center gap-1 ${
            mode === 'viewport'
              ? 'bg-green-600 text-white'
              : 'text-gray-400 hover:text-white hover:bg-gray-700'
          } ${isGenerating || !onCaptureViewport ? 'opacity-50 cursor-not-allowed' : ''}`}
          title={!onCaptureViewport ? 'Viewport capture not available' : 'Capture view to generate'}
        >
          <span>📸</span>
          <span>Viewport</span>
        </button>
      </div>
      
      {/* Library Panel */}
      {showLibrary && (
        <div className="bg-gray-800 rounded-lg p-3 mb-4">
          <h3 className="font-semibold mb-2 flex items-center gap-2">
            <span>📁</span> Generated Objects
            {loadingLibrary && <span className="text-sm text-gray-400">(loading...)</span>}
          </h3>
          
          {library.length === 0 ? (
            <p className="text-gray-400 text-sm">No generated objects yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
              {library.map((item) => (
                <div
                  key={item.filename}
                  className="bg-gray-700 rounded p-2 group relative cursor-pointer hover:bg-gray-600"
                  onClick={() => handleSelectFromLibrary(item)}
                >
                  {item.thumbnailUrl ? (
                    <img
                      src={item.thumbnailUrl}
                      alt={item.filename}
                      className="w-full h-20 object-cover rounded mb-1"
                    />
                  ) : (
                    <div className="w-full h-20 bg-gray-600 rounded mb-1 flex items-center justify-center text-2xl">
                      📦
                    </div>
                  )}
                  <p className="text-xs truncate">{item.filename}</p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteFromLibrary(item);
                    }}
                    className="absolute top-1 right-1 p-1 bg-red-600 rounded opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      
      {/* Viewport Capture Mode */}
      {mode === 'viewport' && onCaptureViewport && (
        <ViewpointCapture
          onCaptureViewport={onCaptureViewport}
          onObjectGenerated={(localPath, _description) => {
            loadLibrary();
            onObjectGenerated?.(localPath, undefined);
          }}
          onGenerationStart={() => setIsGenerating(true)}
          onGenerationEnd={() => setIsGenerating(false)}
        />
      )}
      
      {/* Concept AI Mode - Nano Banana Pro */}
      {mode === 'concept' && (
        <ConceptTo3DPanel
          onObjectGenerated={(objectUrl, _objectName) => {
            loadLibrary();
            onObjectGenerated?.(objectUrl, undefined);
          }}
        />
      )}
      
      {/* Renovation Planner Mode - Precise Dimensions & Cost Estimation */}
      {mode === 'renovation' && (
        <RenovationPlannerPanel
          onCaptureViewport={onCaptureViewport}
          onObjectGenerated={(objectUrl, _objectName, _dimensions: Dimensions) => {
            loadLibrary();
            onObjectGenerated?.(objectUrl, undefined);
          }}
        />
      )}
      
      {/* Text Prompt Mode */}
      {mode === 'presets' && (
        <>
      {/* Category Tabs */}
      <div className="flex flex-wrap gap-1 mb-4">
        {(Object.keys(FURNITURE_PRESETS) as FurnitureCategory[]).map((category) => (
          <button
            key={category}
            onClick={() => {
              setActiveCategory(category);
              setSelectedPreset(null);
            }}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 ${
              activeCategory === category
                ? 'bg-blue-600 text-white'
                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            <span>{categoryIcons[category]}</span>
            <span className="capitalize">{category}</span>
          </button>
        ))}
      </div>
      
      {/* Presets Grid */}
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-400 mb-2">Quick Presets</h3>
        <div className="grid grid-cols-2 gap-2">
          {FURNITURE_PRESETS[activeCategory].map((preset) => (
            <button
              key={preset.name}
              onClick={() => {
                setSelectedPreset(preset.name);
                setCustomPrompt('');
              }}
              disabled={isGenerating}
              className={`p-2 rounded-lg text-left text-sm transition-colors ${
                selectedPreset === preset.name
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              } ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>
      
      {/* Custom Prompt */}
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-400 mb-2">Custom Description</h3>
        <textarea
          value={customPrompt}
          onChange={(e) => {
            setCustomPrompt(e.target.value);
            if (e.target.value) setSelectedPreset(null);
          }}
          placeholder="Describe the 3D object you want to create..."
          className="w-full bg-gray-800 border border-gray-600 rounded-lg p-3 text-sm resize-none focus:border-blue-500 focus:outline-none"
          rows={3}
          maxLength={600}
          disabled={isGenerating}
        />
        <p className="text-xs text-gray-500 mt-1">{customPrompt.length}/600 characters</p>
      </div>
      
      {/* Advanced Options */}
      <div className="mb-4">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
        >
          <span>{showAdvanced ? '▼' : '▶'}</span>
          <span>⚙️ Advanced Options</span>
        </button>
        
        {showAdvanced && (
          <div className="mt-3 p-3 bg-gray-800 rounded-lg space-y-3">
            {/* Art Style */}
            <div>
              <label className="text-xs text-gray-400 block mb-1">Art Style</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setArtStyle('realistic')}
                  className={`flex-1 py-1.5 rounded text-sm ${
                    artStyle === 'realistic' ? 'bg-blue-600' : 'bg-gray-700'
                  }`}
                >
                  Realistic
                </button>
                <button
                  onClick={() => setArtStyle('sculpture')}
                  className={`flex-1 py-1.5 rounded text-sm ${
                    artStyle === 'sculpture' ? 'bg-blue-600' : 'bg-gray-700'
                  }`}
                >
                  Sculpture
                </button>
              </div>
            </div>
            
            {/* Polygon Count */}
            <div>
              <label className="text-xs text-gray-400 block mb-1">
                Polygon Count: {polyCount.toLocaleString()}
              </label>
              <input
                type="range"
                min={5000}
                max={100000}
                step={5000}
                value={polyCount}
                onChange={(e) => setPolyCount(parseInt(e.target.value))}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-gray-500">
                <span>Low (5K)</span>
                <span>High (100K)</span>
              </div>
            </div>
            
            {/* PBR Toggle */}
            <div className="flex items-center justify-between">
              <label className="text-xs text-gray-400">Enable PBR Maps</label>
              <button
                onClick={() => setEnablePBR(!enablePBR)}
                className={`w-12 h-6 rounded-full transition-colors ${
                  enablePBR ? 'bg-blue-600' : 'bg-gray-600'
                }`}
              >
                <div
                  className={`w-5 h-5 bg-white rounded-full transition-transform ${
                    enablePBR ? 'translate-x-6' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>
        )}
      </div>
      
      {/* Error Display */}
      {error && (
        <div className="bg-red-900/50 border border-red-600 rounded-lg p-3 mb-4">
          <p className="text-red-400 text-sm">❌ {error}</p>
        </div>
      )}
      
      {/* Progress Display */}
      {isGenerating && (
        <div className="bg-blue-900/30 border border-blue-600 rounded-lg p-3 mb-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-blue-300">{generationStage}</span>
            <span className="text-sm text-blue-400">{Math.round(generationProgress)}%</span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${generationProgress}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-2">
            ⏱️ Generation typically takes 2-5 minutes
          </p>
        </div>
      )}
      
      {/* Generate Button */}
      <button
        onClick={handleGenerate}
        disabled={isGenerating || (!selectedPreset && !customPrompt.trim())}
        className={`w-full py-3 rounded-lg font-semibold transition-colors flex items-center justify-center gap-2 ${
          isGenerating || (!selectedPreset && !customPrompt.trim())
            ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
            : 'bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white'
        }`}
      >
        {isGenerating ? (
          <>
            <span className="animate-spin">⏳</span>
            Generating...
          </>
        ) : (
          <>
            <span>🪄</span>
            Generate 3D Object
          </>
        )}
      </button>
        </>
      )}
      
      {/* Info */}
      <p className="text-xs text-gray-500 mt-3 text-center">
        Powered by Meshy AI • Objects are generated in GLB format
      </p>
    </div>
  );
};

export default ObjectGeneratorPanel;
