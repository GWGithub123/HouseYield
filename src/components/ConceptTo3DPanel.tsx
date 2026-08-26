/**
 * ConceptTo3DPanel - Two-stage AI Generation
 * 
 * 1. Uses Nano Banana Pro to generate a detailed concept image from text
 * 2. Previews the concept image for approval
 * 3. Converts the approved image into a 3D model
 * 
 * This produces higher quality 3D objects because the concept image
 * provides detailed visual reference for the 3D reconstruction.
 */

import React, { useState, useCallback } from 'react';
import {
  runConceptTo3DPipeline,
  createTextToImageTask,
  pollImageUntilDone,
  downloadConceptImage,
  createImageTo3DFromUrl,
  poll3DUntilDone,
  download3DModel,
  getConceptImageLibrary,
  type PipelineProgress,
  type ConceptImage,
  type ConceptTo3DOptions,
  optimize3DPrompt,
  getEstimatedTimes
} from '../services/meshyConceptTo3DService';

interface ConceptTo3DPanelProps {
  onObjectGenerated?: (objectUrl: string, objectName: string) => void;
}

type WorkflowMode = 'automatic' | 'manual';
type ManualStage = 'prompt' | 'preview' | 'generating-3d' | 'complete';

const ConceptTo3DPanel: React.FC<ConceptTo3DPanelProps> = ({
  onObjectGenerated
}) => {
  // Workflow mode
  const [mode, setMode] = useState<WorkflowMode>('manual');
  
  // Form state
  const [prompt, setPrompt] = useState('');
  const [aiModel, setAiModel] = useState<'nano-banana' | 'nano-banana-pro'>('nano-banana-pro');
  const [aspectRatio, setAspectRatio] = useState<'1:1' | '16:9' | '9:16' | '4:3' | '3:4'>('1:1');
  const [multiView, setMultiView] = useState(false);
  const [optimizePrompt, setOptimizePrompt] = useState(true);
  
  // 3D options
  const [enablePbr, setEnablePbr] = useState(true);
  const [polyCount, setPolyCount] = useState(30000);
  
  // Pipeline state
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress>({ stage: 'idle' });
  const [error, setError] = useState<string | null>(null);
  
  // Manual mode state
  const [manualStage, setManualStage] = useState<ManualStage>('prompt');
  const [conceptImage, setConceptImage] = useState<ConceptImage | null>(null);
  const [conceptImageUrl, setConceptImageUrl] = useState<string | null>(null);
  
  // Library state (for future use)
  const [_showLibrary, setShowLibrary] = useState(false);
  const [_libraryImages, setLibraryImages] = useState<ConceptImage[]>([]);

  // Load library
  const loadLibrary = useCallback(async () => {
    try {
      const { images } = await getConceptImageLibrary();
      setLibraryImages(images);
    } catch (err) {
      console.error('Failed to load library:', err);
    }
  }, []);

  // Automatic pipeline (full end-to-end)
  const runAutomaticPipeline = async () => {
    if (!prompt.trim()) {
      setError('Please enter a description');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setProgress({ stage: 'idle' });

    try {
      const finalPrompt = optimizePrompt ? optimize3DPrompt(prompt) : prompt;
      
      const options: ConceptTo3DOptions = {
        prompt: finalPrompt,
        ai_model: aiModel,
        aspect_ratio: multiView ? undefined : aspectRatio,
        generate_multi_view: multiView,
        enable_pbr: enablePbr,
        target_polycount: polyCount,
      };

      const { conceptImage, finalModel } = await runConceptTo3DPipeline(
        options,
        setProgress
      );

      setConceptImage(conceptImage);
      
      // Notify parent about the generated object
      if (onObjectGenerated) {
        onObjectGenerated(finalModel.path, finalModel.filename);
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setProgress({ stage: 'error', error: message });
    } finally {
      setIsGenerating(false);
    }
  };

  // Manual step 1: Generate concept image
  const generateConceptImage = async () => {
    if (!prompt.trim()) {
      setError('Please enter a description');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setManualStage('prompt');

    try {
      const finalPrompt = optimizePrompt ? optimize3DPrompt(prompt) : prompt;
      
      // Create and poll image task
      const { taskId } = await createTextToImageTask({
        prompt: finalPrompt,
        ai_model: aiModel,
        aspect_ratio: multiView ? undefined : aspectRatio,
        generate_multi_view: multiView,
      });

      setProgress({ stage: 'generating-image', imageTaskId: taskId, imageProgress: 0 });

      const imageTask = await pollImageUntilDone(taskId, (task) => {
        setProgress({ 
          stage: 'generating-image', 
          imageTaskId: taskId, 
          imageProgress: task.progress 
        });
      });

      // Download to local storage
      const { images } = await downloadConceptImage(taskId);
      const image = images[0];
      
      setConceptImage(image);
      setConceptImageUrl(imageTask.image_urls?.[0] || null);
      setManualStage('preview');
      setProgress({ stage: 'image-complete', imageProgress: 100, conceptImage: image });
      
      // Refresh library
      loadLibrary();

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  // Manual step 2: Approve and convert to 3D
  const convertTo3D = async () => {
    if (!conceptImageUrl) {
      setError('No concept image URL available');
      return;
    }

    setIsGenerating(true);
    setError(null);
    setManualStage('generating-3d');

    try {
      // Create Image-to-3D task
      const { taskId } = await createImageTo3DFromUrl(conceptImageUrl, {
        enable_pbr: enablePbr,
        should_texture: true,
        should_remesh: true,
        ai_model: 'latest',
        topology: 'triangle',
        target_polycount: polyCount,
      });

      setProgress({ stage: 'generating-3d', modelTaskId: taskId, modelProgress: 0 });

      await poll3DUntilDone(taskId, (task) => {
        setProgress({ 
          stage: 'generating-3d', 
          modelTaskId: taskId, 
          modelProgress: task.progress 
        });
      });

      // Download the model
      setProgress({ stage: 'downloading', modelProgress: 100 });
      const finalModel = await download3DModel(taskId);

      setProgress({ 
        stage: 'complete', 
        finalModel,
        conceptImage: conceptImage || undefined,
        modelProgress: 100 
      });
      setManualStage('complete');

      // Notify parent
      if (onObjectGenerated) {
        onObjectGenerated(finalModel.path, finalModel.filename);
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setManualStage('preview'); // Go back to preview on error
    } finally {
      setIsGenerating(false);
    }
  };

  // Reset to start over
  const reset = () => {
    setManualStage('prompt');
    setConceptImage(null);
    setConceptImageUrl(null);
    setProgress({ stage: 'idle' });
    setError(null);
  };

  // Use image from library (for future implementation)
  const _useLibraryImage = (_image: ConceptImage) => {
    // For library images, we need to construct the full URL
    // Since they're saved locally, we use the local path
    // But for Meshy API, we need to upload or use the original URL
    // For now, show a message that we need to regenerate or use viewport capture
    setError('Library images need to be re-uploaded. Consider regenerating or using "From Viewport" tab.');
    setShowLibrary(false);
  };

  const getStageEmoji = (stage: string): string => {
    switch (stage) {
      case 'generating-image': return '🎨';
      case 'image-complete': return '✅';
      case 'generating-3d': return '🔮';
      case 'downloading': return '📥';
      case 'complete': return '🎉';
      case 'error': return '❌';
      default: return '⏳';
    }
  };

  const estimates = getEstimatedTimes({ prompt, ai_model: aiModel });

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      padding: '16px',
      backgroundColor: 'rgba(138, 43, 226, 0.1)',
      borderRadius: '12px',
      border: '1px solid rgba(138, 43, 226, 0.3)',
    }}>
      {/* Header */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between' 
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '20px' }}>🎨</span>
          <span style={{ fontWeight: 600, color: '#fff' }}>
            Concept → 3D (Nano Banana Pro)
          </span>
        </div>
        
        {/* Mode Toggle */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={() => setMode('manual')}
            style={{
              padding: '4px 10px',
              fontSize: '12px',
              backgroundColor: mode === 'manual' ? 'rgba(138, 43, 226, 0.8)' : 'rgba(255,255,255,0.1)',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Preview First
          </button>
          <button
            onClick={() => setMode('automatic')}
            style={{
              padding: '4px 10px',
              fontSize: '12px',
              backgroundColor: mode === 'automatic' ? 'rgba(138, 43, 226, 0.8)' : 'rgba(255,255,255,0.1)',
              border: 'none',
              borderRadius: '4px',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Auto Pipeline
          </button>
        </div>
      </div>

      {/* Description */}
      <p style={{ 
        fontSize: '13px', 
        color: 'rgba(255,255,255,0.7)', 
        margin: 0,
        lineHeight: '1.4'
      }}>
        {mode === 'manual' 
          ? '1️⃣ Describe your object → 2️⃣ Preview AI concept image → 3️⃣ Approve & convert to 3D'
          : '🚀 Fully automated: Describe → Generate concept → Convert to 3D (no preview step)'
        }
      </p>

      {/* Prompt Input */}
      {(manualStage === 'prompt' || mode === 'automatic') && (
        <>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the 3D object you want to create in detail...&#10;&#10;Example: A sleek modern coffee table with a glass top and brushed gold metal legs, minimalist design"
            disabled={isGenerating}
            style={{
              width: '100%',
              minHeight: '100px',
              padding: '12px',
              borderRadius: '8px',
              border: '1px solid rgba(255,255,255,0.2)',
              backgroundColor: 'rgba(0,0,0,0.2)',
              color: '#fff',
              fontSize: '14px',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />

          {/* Options */}
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: '12px' 
          }}>
            {/* AI Model */}
            <div>
              <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
                Image AI Model
              </label>
              <select
                value={aiModel}
                onChange={(e) => setAiModel(e.target.value as any)}
                disabled={isGenerating}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  backgroundColor: 'rgba(0,0,0,0.3)',
                  color: '#fff',
                  fontSize: '13px',
                }}
              >
                <option value="nano-banana-pro">🌟 Nano Banana Pro</option>
                <option value="nano-banana">Nano Banana</option>
              </select>
            </div>

            {/* Aspect Ratio */}
            <div>
              <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
                Aspect Ratio
              </label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value as any)}
                disabled={isGenerating || multiView}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  backgroundColor: 'rgba(0,0,0,0.3)',
                  color: '#fff',
                  fontSize: '13px',
                  opacity: multiView ? 0.5 : 1,
                }}
              >
                <option value="1:1">1:1 (Square)</option>
                <option value="16:9">16:9 (Wide)</option>
                <option value="9:16">9:16 (Tall)</option>
                <option value="4:3">4:3 (Standard)</option>
                <option value="3:4">3:4 (Portrait)</option>
              </select>
            </div>

            {/* Poly Count */}
            <div>
              <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
                3D Poly Count
              </label>
              <select
                value={polyCount}
                onChange={(e) => setPolyCount(Number(e.target.value))}
                disabled={isGenerating}
                style={{
                  width: '100%',
                  padding: '8px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  backgroundColor: 'rgba(0,0,0,0.3)',
                  color: '#fff',
                  fontSize: '13px',
                }}
              >
                <option value={10000}>10K (Fast)</option>
                <option value={30000}>30K (Balanced)</option>
                <option value={50000}>50K (Detailed)</option>
              </select>
            </div>
          </div>

          {/* Checkboxes */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
            <label style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '6px', 
              fontSize: '13px', 
              color: 'rgba(255,255,255,0.8)',
              cursor: 'pointer' 
            }}>
              <input
                type="checkbox"
                checked={optimizePrompt}
                onChange={(e) => setOptimizePrompt(e.target.checked)}
                disabled={isGenerating}
              />
              ✨ Optimize for 3D
            </label>
            
            <label style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '6px', 
              fontSize: '13px', 
              color: 'rgba(255,255,255,0.8)',
              cursor: 'pointer' 
            }}>
              <input
                type="checkbox"
                checked={enablePbr}
                onChange={(e) => setEnablePbr(e.target.checked)}
                disabled={isGenerating}
              />
              🎨 PBR Materials
            </label>

            <label style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '6px', 
              fontSize: '13px', 
              color: 'rgba(255,255,255,0.8)',
              cursor: 'pointer' 
            }}>
              <input
                type="checkbox"
                checked={multiView}
                onChange={(e) => setMultiView(e.target.checked)}
                disabled={isGenerating}
              />
              🔄 Multi-View
            </label>
          </div>

          {/* Time Estimate */}
          <div style={{ 
            fontSize: '12px', 
            color: 'rgba(255,255,255,0.5)',
            padding: '8px',
            backgroundColor: 'rgba(0,0,0,0.2)',
            borderRadius: '6px',
          }}>
            ⏱️ Estimated time: {mode === 'automatic' ? estimates.total : estimates.imageGeneration} 
            {mode === 'manual' && manualStage === 'prompt' && ' for concept image'}
          </div>

          {/* Generate Button */}
          <button
            onClick={mode === 'automatic' ? runAutomaticPipeline : generateConceptImage}
            disabled={isGenerating || !prompt.trim()}
            style={{
              padding: '14px 24px',
              backgroundColor: isGenerating ? 'rgba(255,255,255,0.2)' : 'linear-gradient(135deg, #8B5CF6 0%, #A855F7 100%)',
              background: isGenerating ? 'rgba(255,255,255,0.2)' : 'linear-gradient(135deg, #8B5CF6 0%, #A855F7 100%)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 600,
              cursor: isGenerating ? 'not-allowed' : 'pointer',
              opacity: isGenerating || !prompt.trim() ? 0.7 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
            }}
          >
            {isGenerating ? (
              <>
                <span className="spinner" style={{ 
                  width: '16px', 
                  height: '16px', 
                  border: '2px solid rgba(255,255,255,0.3)',
                  borderTop: '2px solid #fff',
                  borderRadius: '50%',
                  animation: 'spin 1s linear infinite',
                }} />
                {mode === 'automatic' ? 'Generating...' : 'Creating Concept...'}
              </>
            ) : (
              <>
                {mode === 'automatic' ? '🚀 Generate 3D Object' : '🎨 Generate Concept Image'}
              </>
            )}
          </button>
        </>
      )}

      {/* Preview Stage (Manual Mode) */}
      {mode === 'manual' && manualStage === 'preview' && conceptImage && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between' 
          }}>
            <h3 style={{ margin: 0, color: '#fff', fontSize: '16px' }}>
              ✅ Concept Image Ready
            </h3>
            <button
              onClick={reset}
              style={{
                padding: '6px 12px',
                backgroundColor: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '6px',
                color: '#fff',
                fontSize: '12px',
                cursor: 'pointer',
              }}
            >
              ↩️ Start Over
            </button>
          </div>

          {/* Image Preview */}
          <div style={{
            position: 'relative',
            borderRadius: '8px',
            overflow: 'hidden',
            backgroundColor: 'rgba(0,0,0,0.3)',
          }}>
            <img
              src={conceptImage.path}
              alt="Concept preview"
              style={{
                width: '100%',
                maxHeight: '300px',
                objectFit: 'contain',
              }}
            />
          </div>

          {/* Approve and Generate 3D */}
          <div style={{ 
            display: 'flex', 
            gap: '12px',
            flexWrap: 'wrap',
          }}>
            <button
              onClick={convertTo3D}
              disabled={isGenerating}
              style={{
                flex: 1,
                minWidth: '200px',
                padding: '14px 24px',
                background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '15px',
                fontWeight: 600,
                cursor: isGenerating ? 'not-allowed' : 'pointer',
                opacity: isGenerating ? 0.7 : 1,
              }}
            >
              ✅ Approve & Convert to 3D
            </button>
            
            <button
              onClick={reset}
              disabled={isGenerating}
              style={{
                padding: '14px 24px',
                backgroundColor: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.2)',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              🔄 Try Different Prompt
            </button>
          </div>

          <p style={{ 
            fontSize: '12px', 
            color: 'rgba(255,255,255,0.5)', 
            margin: 0 
          }}>
            ⏱️ 3D conversion will take approximately {estimates.modelGeneration}
          </p>
        </div>
      )}

      {/* 3D Generation Stage (Manual Mode) */}
      {mode === 'manual' && manualStage === 'generating-3d' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', alignItems: 'center' }}>
          <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            gap: '12px' 
          }}>
            <div style={{ 
              width: '60px', 
              height: '60px', 
              borderRadius: '50%',
              backgroundColor: 'rgba(138, 43, 226, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '28px',
            }}>
              🔮
            </div>
            <h3 style={{ margin: 0, color: '#fff' }}>Converting to 3D Model</h3>
          </div>
          
          {/* Progress Bar */}
          <div style={{ width: '100%' }}>
            <div style={{ 
              width: '100%', 
              height: '8px', 
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: '4px',
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${progress.modelProgress || 0}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #8B5CF6, #A855F7)',
                transition: 'width 0.5s ease',
              }} />
            </div>
            <p style={{ 
              textAlign: 'center', 
              color: 'rgba(255,255,255,0.7)',
              fontSize: '14px',
              marginTop: '8px',
            }}>
              {progress.modelProgress || 0}% complete
            </p>
          </div>
        </div>
      )}

      {/* Complete Stage */}
      {(progress.stage === 'complete' || manualStage === 'complete') && (
        <div style={{ 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'center', 
          gap: '16px',
          padding: '20px',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          borderRadius: '12px',
          border: '1px solid rgba(16, 185, 129, 0.3)',
        }}>
          <div style={{ fontSize: '48px' }}>🎉</div>
          <h3 style={{ margin: 0, color: '#10B981' }}>3D Object Generated!</h3>
          <p style={{ 
            color: 'rgba(255,255,255,0.7)', 
            fontSize: '14px', 
            textAlign: 'center',
            margin: 0,
          }}>
            Your object has been created and is ready to place in the scene.
          </p>
          
          <button
            onClick={reset}
            style={{
              padding: '12px 24px',
              backgroundColor: 'rgba(138, 43, 226, 0.8)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ➕ Create Another Object
          </button>
        </div>
      )}

      {/* Progress Display (Automatic Mode) */}
      {mode === 'automatic' && isGenerating && (
        <div style={{
          padding: '16px',
          backgroundColor: 'rgba(0,0,0,0.2)',
          borderRadius: '8px',
        }}>
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '8px',
            marginBottom: '12px',
          }}>
            <span style={{ fontSize: '20px' }}>{getStageEmoji(progress.stage)}</span>
            <span style={{ color: '#fff', fontWeight: 500 }}>
              {progress.stage === 'generating-image' && 'Generating concept image...'}
              {progress.stage === 'image-complete' && 'Concept image ready!'}
              {progress.stage === 'generating-3d' && 'Converting to 3D model...'}
              {progress.stage === 'downloading' && 'Downloading model...'}
            </span>
          </div>
          
          {/* Progress Bar */}
          <div style={{ 
            width: '100%', 
            height: '8px', 
            backgroundColor: 'rgba(255,255,255,0.1)',
            borderRadius: '4px',
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${progress.stage === 'generating-3d' || progress.stage === 'downloading' 
                ? (50 + (progress.modelProgress || 0) / 2) 
                : (progress.imageProgress || 0) / 2}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #8B5CF6, #A855F7, #10B981)',
              transition: 'width 0.5s ease',
            }} />
          </div>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div style={{
          padding: '12px 16px',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
          borderRadius: '8px',
          color: '#EF4444',
          fontSize: '13px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span>❌</span>
          <span>{error}</span>
        </div>
      )}

      {/* CSS for spinner animation */}
      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

export default ConceptTo3DPanel;
