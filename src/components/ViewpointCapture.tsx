/**
 * ViewpointCapture Component
 * 
 * Captures the current 3D viewport view and allows users to describe 
 * what object they want to generate from that viewpoint
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  createImageTo3DTask,
  getTaskStatus,
  downloadModel,
  pollUntilDone,
  type ImageTo3DTask,
  type ImageTo3DOptions
} from '../services/meshyImageTo3DService';

interface ViewpointCaptureProps {
  // Function to capture the current viewport - provided by parent
  onCaptureViewport: () => string | null;
  // Called when an object is successfully generated
  onObjectGenerated?: (localPath: string, description: string) => void;
  // Called when generation starts (to disable other controls)
  onGenerationStart?: () => void;
  // Called when generation ends
  onGenerationEnd?: () => void;
}

type GenerationStage = 'idle' | 'capturing' | 'uploading' | 'generating' | 'downloading' | 'complete' | 'error';

interface GenerationState {
  stage: GenerationStage;
  progress: number;
  message: string;
  taskId?: string;
  error?: string;
}

export const ViewpointCapture: React.FC<ViewpointCaptureProps> = ({
  onCaptureViewport,
  onObjectGenerated,
  onGenerationStart,
  onGenerationEnd,
}) => {
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [generationState, setGenerationState] = useState<GenerationState>({
    stage: 'idle',
    progress: 0,
    message: 'Ready to capture',
  });
  
  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [options, setOptions] = useState<ImageTo3DOptions>({
    enable_pbr: true,
    ai_model: 'latest',
    target_polycount: 30000,
    topology: 'triangle',
  });

  // Capture the current viewport
  const handleCapture = useCallback(() => {
    const imageData = onCaptureViewport();
    if (imageData) {
      setCapturedImage(imageData);
      setGenerationState({
        stage: 'idle',
        progress: 0,
        message: 'Image captured! Describe what object you see.',
      });
    } else {
      setGenerationState({
        stage: 'error',
        progress: 0,
        message: 'Failed to capture viewport',
        error: 'Could not capture the current view',
      });
    }
  }, [onCaptureViewport]);

  // Start generation from captured image
  const handleGenerate = useCallback(async () => {
    if (!capturedImage) {
      setGenerationState({
        stage: 'error',
        progress: 0,
        message: 'No image captured',
        error: 'Please capture a viewport first',
      });
      return;
    }

    if (!description.trim()) {
      setGenerationState({
        stage: 'error',
        progress: 0,
        message: 'Description required',
        error: 'Please describe the object you want to generate',
      });
      return;
    }

    onGenerationStart?.();

    try {
      // Stage 1: Upload and create task
      setGenerationState({
        stage: 'uploading',
        progress: 10,
        message: 'Uploading image to Meshy AI...',
      });

      const createResult = await createImageTo3DTask(capturedImage, description.trim(), options);

      if (!createResult.success || !createResult.taskId) {
        throw new Error(createResult.error || 'Failed to create generation task');
      }

      // Stage 2: Poll for generation progress
      setGenerationState({
        stage: 'generating',
        progress: 20,
        message: 'AI is analyzing your image...',
        taskId: createResult.taskId,
      });

      const task = await pollUntilDone(
        createResult.taskId,
        (t: ImageTo3DTask) => {
          // Map Meshy progress (0-100) to our progress (20-90)
          const mappedProgress = 20 + (t.progress * 0.7);
          
          let message = 'Generating 3D model...';
          if (t.progress < 20) message = 'Analyzing image structure...';
          else if (t.progress < 50) message = 'Building 3D geometry...';
          else if (t.progress < 80) message = 'Applying textures...';
          else message = 'Finalizing model...';

          setGenerationState({
            stage: 'generating',
            progress: mappedProgress,
            message: `${message} (${t.progress}%)`,
            taskId: createResult.taskId,
          });
        },
        3000, // Poll every 3 seconds
        200   // Max 10 minutes
      );

      if (!task || task.status !== 'SUCCEEDED') {
        throw new Error(task?.error || 'Generation failed');
      }

      // Stage 3: Download the model
      setGenerationState({
        stage: 'downloading',
        progress: 92,
        message: 'Downloading generated model...',
        taskId: createResult.taskId,
      });

      const downloadResult = await downloadModel(createResult.taskId);

      if (!downloadResult.success || !downloadResult.localPath) {
        throw new Error(downloadResult.error || 'Failed to download model');
      }

      // Complete!
      setGenerationState({
        stage: 'complete',
        progress: 100,
        message: 'Object generated successfully!',
        taskId: createResult.taskId,
      });

      onObjectGenerated?.(downloadResult.localPath, description.trim());

    } catch (error) {
      console.error('[ViewpointCapture] Generation error:', error);
      setGenerationState({
        stage: 'error',
        progress: 0,
        message: 'Generation failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      onGenerationEnd?.();
    }
  }, [capturedImage, description, options, onGenerationStart, onGenerationEnd, onObjectGenerated]);

  // Reset to initial state
  const handleReset = useCallback(() => {
    setCapturedImage(null);
    setDescription('');
    setGenerationState({
      stage: 'idle',
      progress: 0,
      message: 'Ready to capture',
    });
  }, []);

  const isGenerating = ['uploading', 'generating', 'downloading'].includes(generationState.stage);

  return (
    <div className="space-y-4">
      {/* Instructions */}
      <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg p-4">
        <h3 className="font-medium text-purple-800 mb-2 flex items-center gap-2">
          <span className="text-xl">📸</span>
          Capture & Generate
        </h3>
        <p className="text-sm text-purple-700">
          Position your view to look at an object in the room, capture the view, 
          then describe what you want to recreate or modify as a 3D model.
        </p>
      </div>

      {/* Captured Image Preview */}
      <div className="relative">
        {capturedImage ? (
          <div className="relative rounded-lg overflow-hidden border-2 border-purple-300 bg-gray-100">
            <img 
              src={capturedImage} 
              alt="Captured viewport" 
              className="w-full h-48 object-contain"
            />
            {!isGenerating && generationState.stage !== 'complete' && (
              <button
                onClick={handleCapture}
                className="absolute top-2 right-2 bg-white/90 hover:bg-white text-gray-700 px-2 py-1 rounded text-sm shadow"
              >
                📷 Recapture
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={handleCapture}
            className="w-full h-48 border-2 border-dashed border-purple-300 rounded-lg bg-purple-50 hover:bg-purple-100 transition-colors flex flex-col items-center justify-center gap-2"
          >
            <span className="text-4xl">📸</span>
            <span className="text-purple-700 font-medium">Capture Current View</span>
            <span className="text-sm text-purple-500">Position your camera first, then click here</span>
          </button>
        )}
      </div>

      {/* Description Input */}
      {capturedImage && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-700">
            Describe the object to generate:
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g., 'Modern leather armchair with wooden legs' or 'That coffee table but with a glass top'"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
            rows={3}
            disabled={isGenerating}
          />
          <p className="text-xs text-gray-500">
            💡 Be specific about materials, style, and any modifications you want
          </p>
        </div>
      )}

      {/* Advanced Options */}
      {capturedImage && !isGenerating && generationState.stage !== 'complete' && (
        <div className="border border-gray-200 rounded-lg">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full px-4 py-2 flex items-center justify-between text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <span>⚙️ Advanced Options</span>
            <span>{showAdvanced ? '▲' : '▼'}</span>
          </button>
          
          {showAdvanced && (
            <div className="px-4 py-3 border-t border-gray-200 space-y-3">
              {/* AI Model */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">AI Model</label>
                <select
                  value={options.ai_model}
                  onChange={(e) => setOptions({ ...options, ai_model: e.target.value as any })}
                  className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                >
                  <option value="latest">Meshy 6 Preview (Best)</option>
                  <option value="meshy-5">Meshy 5</option>
                  <option value="meshy-4">Meshy 4</option>
                </select>
              </div>

              {/* Poly Count */}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Target Polygons: {options.target_polycount?.toLocaleString()}
                </label>
                <input
                  type="range"
                  min="5000"
                  max="100000"
                  step="5000"
                  value={options.target_polycount}
                  onChange={(e) => setOptions({ ...options, target_polycount: parseInt(e.target.value) })}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-gray-400">
                  <span>5K (Fast)</span>
                  <span>100K (Detailed)</span>
                </div>
              </div>

              {/* PBR Toggle */}
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={options.enable_pbr}
                  onChange={(e) => setOptions({ ...options, enable_pbr: e.target.checked })}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Enable PBR materials (realistic lighting)</span>
              </label>
            </div>
          )}
        </div>
      )}

      {/* Progress Bar */}
      {isGenerating && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-700">{generationState.message}</span>
            <span className="text-purple-600 font-medium">{Math.round(generationState.progress)}%</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
            <div 
              className="bg-gradient-to-r from-purple-500 to-indigo-500 h-full transition-all duration-500 ease-out"
              style={{ width: `${generationState.progress}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 text-center">
            ⏱️ This may take 2-5 minutes depending on complexity
          </p>
        </div>
      )}

      {/* Error Display */}
      {generationState.stage === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3">
          <p className="text-red-700 text-sm font-medium">{generationState.message}</p>
          {generationState.error && (
            <p className="text-red-600 text-xs mt-1">{generationState.error}</p>
          )}
        </div>
      )}

      {/* Success Display */}
      {generationState.stage === 'complete' && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
          <span className="text-3xl">✅</span>
          <p className="text-green-700 font-medium mt-2">Object Generated!</p>
          <p className="text-green-600 text-sm">Your 3D model is ready to place in the scene</p>
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex gap-2">
        {capturedImage && !isGenerating && generationState.stage !== 'complete' && (
          <button
            onClick={handleGenerate}
            disabled={!description.trim()}
            className="flex-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:from-gray-400 disabled:to-gray-500 text-white font-medium py-3 px-4 rounded-lg transition-all shadow-lg disabled:shadow-none"
          >
            🚀 Generate 3D Object
          </button>
        )}
        
        {(generationState.stage === 'complete' || generationState.stage === 'error') && (
          <button
            onClick={handleReset}
            className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 font-medium py-3 px-4 rounded-lg transition-colors"
          >
            🔄 Start Over
          </button>
        )}
      </div>

      {/* Tips */}
      {!capturedImage && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3">
          <p className="text-yellow-800 text-sm font-medium mb-1">💡 Tips for best results:</p>
          <ul className="text-yellow-700 text-xs space-y-1">
            <li>• Get a clear view of the object you want to recreate</li>
            <li>• Avoid capturing multiple objects at once</li>
            <li>• Good lighting in the scene helps the AI understand shapes</li>
            <li>• You can describe modifications (different color, material, etc.)</li>
          </ul>
        </div>
      )}
    </div>
  );
};

export default ViewpointCapture;
