/**
 * RenovationPlannerPanel - Professional Renovation Planning
 * 
 * Features:
 * 1. Capture room context from viewport
 * 2. Describe object with exact dimensions (width × height × depth)
 * 3. Select materials and finishes
 * 4. Generate concept image using Nano Banana Pro (with room context)
 * 5. Convert to precise 3D model
 * 6. Get cost and labor estimates
 * 
 * All dimensions are tracked for accurate real-world renovation planning.
 */

import React, { useState, useCallback } from 'react';
import {
  runRenovationPipeline,
  type CreatePlanOptions,
  type PipelineProgress,
  type CostEstimation,
  type Dimensions,
  formatDimensions,
  formatCost,
  MATERIAL_OPTIONS,
  FINISH_OPTIONS,
  ROOM_TYPE_OPTIONS,
  CATEGORY_OPTIONS,
} from '../services/renovationPlannerService';

interface RenovationPlannerPanelProps {
  onCaptureViewport?: () => string | null;
  onObjectGenerated?: (objectUrl: string, objectName: string, dimensions: Dimensions) => void;
}

type PlannerStage = 'input' | 'preview-concept' | 'generating' | 'complete';

const RenovationPlannerPanel: React.FC<RenovationPlannerPanelProps> = ({
  onCaptureViewport,
  onObjectGenerated,
}) => {
  // Form state
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<'furniture' | 'fixture' | 'appliance' | 'structural'>('furniture');
  const [roomType, setRoomType] = useState('general');
  
  // Dimensions
  const [width, setWidth] = useState<string>('');
  const [height, setHeight] = useState<string>('');
  const [depth, setDepth] = useState<string>('');
  const [unit, setUnit] = useState<'inches' | 'cm'>('inches');
  
  // Materials
  const [selectedMaterials, setSelectedMaterials] = useState<string[]>([]);
  const [finish, setFinish] = useState<string>('');
  
  // Room context
  const [roomImage, setRoomImage] = useState<string | null>(null);
  const [useRoomContext, setUseRoomContext] = useState(true);
  
  // Pipeline state
  const [stage, setStage] = useState<PlannerStage>('input');
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress>({ stage: 'idle' });
  const [error, setError] = useState<string | null>(null);
  
  // Results
  const [conceptImagePath, setConceptImagePath] = useState<string | null>(null);
  const [model3dPath, setModel3dPath] = useState<string | null>(null);
  const [finalDimensions, setFinalDimensions] = useState<Dimensions | null>(null);
  const [costEstimation, setCostEstimation] = useState<CostEstimation | null>(null);
  const [_planId, setPlanId] = useState<string | null>(null);

  // Capture viewport for room context
  const handleCaptureRoom = useCallback(() => {
    if (!onCaptureViewport) {
      setError('Viewport capture not available');
      return;
    }

    try {
      const imageData = onCaptureViewport();
      if (imageData) {
        setRoomImage(imageData);
        setError(null);
      } else {
        setError('Failed to capture viewport');
      }
    } catch (err) {
      setError('Error capturing viewport');
    }
  }, [onCaptureViewport]);

  // Toggle material selection
  const toggleMaterial = (material: string) => {
    setSelectedMaterials(prev => 
      prev.includes(material) 
        ? prev.filter(m => m !== material)
        : [...prev, material]
    );
  };

  // Validate form
  const isFormValid = () => {
    if (!description.trim()) return false;
    if (!width || !height || !depth) return false;
    if (parseFloat(width) <= 0 || parseFloat(height) <= 0 || parseFloat(depth) <= 0) return false;
    return true;
  };

  // Run the full pipeline
  const handleGenerateRenovation = async () => {
    if (!isFormValid()) {
      setError('Please fill in all required fields (description and dimensions)');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setStage('generating');

    try {
      const options: CreatePlanOptions = {
        description,
        category,
        roomType,
        dimensions: {
          width: parseFloat(width),
          height: parseFloat(height),
          depth: parseFloat(depth),
          unit,
        },
        materials: selectedMaterials,
        finish: finish || undefined,
        roomImageBase64: useRoomContext && roomImage ? roomImage : undefined,
      };

      const result = await runRenovationPipeline(options, (p) => {
        setProgress(p);
        if (p.planId) setPlanId(p.planId);
      });

      setConceptImagePath(result.conceptImagePath);
      setModel3dPath(result.model3dPath);
      setFinalDimensions(result.dimensions);
      setCostEstimation(result.costEstimation);
      setStage('complete');

      // Notify parent
      if (onObjectGenerated && result.model3dPath) {
        onObjectGenerated(result.model3dPath, description, result.dimensions);
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStage('input');
    } finally {
      setIsProcessing(false);
    }
  };

  // Reset to start over
  const handleReset = () => {
    setStage('input');
    setProgress({ stage: 'idle' });
    setConceptImagePath(null);
    setModel3dPath(null);
    setCostEstimation(null);
    setError(null);
  };

  const getProgressMessage = (): string => {
    switch (progress.stage) {
      case 'creating-plan': return '📋 Creating renovation plan...';
      case 'generating-concept': return `🎨 Generating concept image (${progress.conceptProgress || 0}%)...`;
      case 'saving-concept': return '💾 Saving concept image...';
      case 'generating-3d': return `🔮 Converting to 3D model (${progress.model3dProgress || 0}%)...`;
      case 'saving-3d': return '💾 Saving 3D model...';
      case 'estimating-cost': return '💰 Calculating cost estimates...';
      case 'complete': return '✅ Complete!';
      default: return 'Processing...';
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
      padding: '16px',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      borderRadius: '12px',
      border: '1px solid rgba(59, 130, 246, 0.3)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '20px' }}>🏠</span>
        <span style={{ fontWeight: 600, color: '#fff' }}>
          Renovation Planner
        </span>
        <span style={{ 
          fontSize: '11px', 
          padding: '2px 6px', 
          backgroundColor: 'rgba(59, 130, 246, 0.3)',
          borderRadius: '4px',
          color: 'rgba(255,255,255,0.8)'
        }}>
          Pro
        </span>
      </div>

      {/* Description */}
      <p style={{ 
        fontSize: '13px', 
        color: 'rgba(255,255,255,0.7)', 
        margin: 0,
        lineHeight: '1.4'
      }}>
        Create precise 3D objects with exact dimensions for renovation planning. 
        Get material and labor cost estimates.
      </p>

      {/* Input Stage */}
      {stage === 'input' && (
        <>
          {/* Room Context Capture */}
          {onCaptureViewport && (
            <div style={{
              padding: '12px',
              backgroundColor: 'rgba(0,0,0,0.2)',
              borderRadius: '8px',
            }}>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'space-between',
                marginBottom: '8px',
              }}>
                <label style={{ 
                  fontSize: '13px', 
                  color: 'rgba(255,255,255,0.8)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={useRoomContext}
                    onChange={(e) => setUseRoomContext(e.target.checked)}
                  />
                  📷 Use Room Context
                </label>
                
                {useRoomContext && (
                  <button
                    onClick={handleCaptureRoom}
                    style={{
                      padding: '6px 12px',
                      backgroundColor: roomImage ? 'rgba(16, 185, 129, 0.3)' : 'rgba(59, 130, 246, 0.3)',
                      border: '1px solid rgba(255,255,255,0.2)',
                      borderRadius: '6px',
                      color: '#fff',
                      fontSize: '12px',
                      cursor: 'pointer',
                    }}
                  >
                    {roomImage ? '✅ Captured' : '📸 Capture View'}
                  </button>
                )}
              </div>
              
              {useRoomContext && roomImage && (
                <img 
                  src={roomImage} 
                  alt="Room context" 
                  style={{
                    width: '100%',
                    height: '80px',
                    objectFit: 'cover',
                    borderRadius: '6px',
                    opacity: 0.8,
                  }}
                />
              )}
              
              {useRoomContext && !roomImage && (
                <p style={{ 
                  fontSize: '12px', 
                  color: 'rgba(255,255,255,0.5)',
                  margin: 0,
                }}>
                  Capture your current view for AI to understand room context
                </p>
              )}
            </div>
          )}

          {/* Description Input */}
          <div>
            <label style={{ 
              fontSize: '12px', 
              color: 'rgba(255,255,255,0.6)', 
              display: 'block', 
              marginBottom: '4px' 
            }}>
              Object Description *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the object you want to create...&#10;&#10;Example: Modern floating bathroom vanity with double sinks, undermount basins, and soft-close drawers"
              style={{
                width: '100%',
                minHeight: '80px',
                padding: '10px',
                borderRadius: '8px',
                border: '1px solid rgba(255,255,255,0.2)',
                backgroundColor: 'rgba(0,0,0,0.2)',
                color: '#fff',
                fontSize: '13px',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Dimensions Input */}
          <div>
            <label style={{ 
              fontSize: '12px', 
              color: 'rgba(255,255,255,0.6)', 
              display: 'block', 
              marginBottom: '8px' 
            }}>
              📐 Exact Dimensions * (for accurate cost estimation)
            </label>
            
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: '1fr 1fr 1fr auto',
              gap: '8px',
              alignItems: 'end',
            }}>
              <div>
                <label style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>Width</label>
                <input
                  type="number"
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                  placeholder="36"
                  min="0"
                  step="0.5"
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(255,255,255,0.2)',
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    color: '#fff',
                    fontSize: '14px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              
              <div>
                <label style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>Height</label>
                <input
                  type="number"
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                  placeholder="24"
                  min="0"
                  step="0.5"
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(255,255,255,0.2)',
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    color: '#fff',
                    fontSize: '14px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              
              <div>
                <label style={{ fontSize: '11px', color: 'rgba(255,255,255,0.5)' }}>Depth</label>
                <input
                  type="number"
                  value={depth}
                  onChange={(e) => setDepth(e.target.value)}
                  placeholder="20"
                  min="0"
                  step="0.5"
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(255,255,255,0.2)',
                    backgroundColor: 'rgba(0,0,0,0.3)',
                    color: '#fff',
                    fontSize: '14px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
              
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as 'inches' | 'cm')}
                style={{
                  padding: '8px',
                  borderRadius: '6px',
                  border: '1px solid rgba(255,255,255,0.2)',
                  backgroundColor: 'rgba(0,0,0,0.3)',
                  color: '#fff',
                  fontSize: '13px',
                }}
              >
                <option value="inches">in</option>
                <option value="cm">cm</option>
              </select>
            </div>
          </div>

          {/* Category & Room Type */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as any)}
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
                {CATEGORY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            
            <div>
              <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
                Room Type
              </label>
              <select
                value={roomType}
                onChange={(e) => setRoomType(e.target.value)}
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
                {ROOM_TYPE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Materials Selection */}
          <div>
            <label style={{ 
              fontSize: '12px', 
              color: 'rgba(255,255,255,0.6)', 
              display: 'block', 
              marginBottom: '8px' 
            }}>
              🪵 Materials (for cost estimation)
            </label>
            <div style={{ 
              display: 'flex', 
              flexWrap: 'wrap', 
              gap: '6px' 
            }}>
              {MATERIAL_OPTIONS.slice(0, 10).map(mat => (
                <button
                  key={mat.value}
                  onClick={() => toggleMaterial(mat.value)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: '16px',
                    border: '1px solid rgba(255,255,255,0.2)',
                    backgroundColor: selectedMaterials.includes(mat.value) 
                      ? 'rgba(59, 130, 246, 0.5)' 
                      : 'rgba(0,0,0,0.2)',
                    color: '#fff',
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                >
                  {mat.label}
                </button>
              ))}
            </div>
          </div>

          {/* Finish Selection */}
          <div>
            <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', display: 'block', marginBottom: '4px' }}>
              ✨ Finish
            </label>
            <select
              value={finish}
              onChange={(e) => setFinish(e.target.value)}
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
              <option value="">Select finish...</option>
              {FINISH_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Error Display */}
          {error && (
            <div style={{
              padding: '10px',
              backgroundColor: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '8px',
              color: '#EF4444',
              fontSize: '13px',
            }}>
              ❌ {error}
            </div>
          )}

          {/* Generate Button */}
          <button
            onClick={handleGenerateRenovation}
            disabled={isProcessing || !isFormValid()}
            style={{
              padding: '14px 24px',
              background: isProcessing || !isFormValid()
                ? 'rgba(255,255,255,0.2)'
                : 'linear-gradient(135deg, #3B82F6 0%, #2563EB 100%)',
              border: 'none',
              borderRadius: '8px',
              color: '#fff',
              fontSize: '15px',
              fontWeight: 600,
              cursor: isProcessing || !isFormValid() ? 'not-allowed' : 'pointer',
              opacity: isProcessing || !isFormValid() ? 0.7 : 1,
            }}
          >
            🏠 Generate Renovation Object
          </button>

          <p style={{ 
            fontSize: '11px', 
            color: 'rgba(255,255,255,0.5)', 
            margin: 0,
            textAlign: 'center',
          }}>
            ⏱️ Estimated time: 3-6 minutes • Dimensions are used for accurate cost estimates
          </p>
        </>
      )}

      {/* Generating Stage */}
      {stage === 'generating' && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '16px',
          padding: '24px',
        }}>
          <div style={{
            width: '60px',
            height: '60px',
            borderRadius: '50%',
            backgroundColor: 'rgba(59, 130, 246, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '28px',
            animation: 'pulse 2s ease-in-out infinite',
          }}>
            {progress.stage === 'generating-concept' ? '🎨' :
             progress.stage === 'generating-3d' ? '🔮' :
             progress.stage === 'estimating-cost' ? '💰' : '⚙️'}
          </div>
          
          <h3 style={{ margin: 0, color: '#fff', textAlign: 'center' }}>
            {getProgressMessage()}
          </h3>
          
          {/* Progress Bar */}
          <div style={{ width: '100%', maxWidth: '300px' }}>
            <div style={{
              width: '100%',
              height: '8px',
              backgroundColor: 'rgba(255,255,255,0.1)',
              borderRadius: '4px',
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${
                  progress.stage === 'generating-concept' ? (progress.conceptProgress || 0) / 2 :
                  progress.stage === 'generating-3d' ? 50 + (progress.model3dProgress || 0) / 2 :
                  progress.stage === 'complete' ? 100 : 10
                }%`,
                height: '100%',
                background: 'linear-gradient(90deg, #3B82F6, #8B5CF6)',
                transition: 'width 0.5s ease',
              }} />
            </div>
          </div>

          {/* Show dimensions being created */}
          {width && height && depth && (
            <p style={{ 
              fontSize: '13px', 
              color: 'rgba(255,255,255,0.6)',
              margin: 0,
            }}>
              Creating: {width} × {height} × {depth} {unit === 'cm' ? 'cm' : '"'}
            </p>
          )}
        </div>
      )}

      {/* Complete Stage */}
      {stage === 'complete' && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}>
          {/* Success Header */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '12px',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            borderRadius: '8px',
            border: '1px solid rgba(16, 185, 129, 0.3)',
          }}>
            <span style={{ fontSize: '24px' }}>🎉</span>
            <span style={{ color: '#10B981', fontWeight: 600 }}>Renovation Object Created!</span>
          </div>

          {/* Concept Image Preview */}
          {conceptImagePath && (
            <div>
              <label style={{ fontSize: '12px', color: 'rgba(255,255,255,0.6)', marginBottom: '4px', display: 'block' }}>
                Concept Image
              </label>
              <img 
                src={conceptImagePath} 
                alt="Concept" 
                style={{
                  width: '100%',
                  borderRadius: '8px',
                  maxHeight: '150px',
                  objectFit: 'cover',
                }}
              />
            </div>
          )}

          {/* Dimensions */}
          {finalDimensions && (
            <div style={{
              padding: '12px',
              backgroundColor: 'rgba(0,0,0,0.2)',
              borderRadius: '8px',
            }}>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'space-between' 
              }}>
                <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)' }}>
                  📐 Dimensions
                </span>
                <span style={{ fontSize: '14px', color: '#fff', fontWeight: 500 }}>
                  {formatDimensions(finalDimensions)}
                </span>
              </div>
            </div>
          )}

          {/* Cost Estimation */}
          {costEstimation && (
            <div style={{
              padding: '16px',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
              borderRadius: '8px',
              border: '1px solid rgba(59, 130, 246, 0.3)',
            }}>
              <h4 style={{ 
                margin: '0 0 12px 0', 
                fontSize: '14px', 
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}>
                💰 Cost Estimation
              </h4>
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                    Materials
                  </p>
                  <p style={{ margin: '4px 0 0 0', fontSize: '16px', color: '#fff', fontWeight: 500 }}>
                    {formatCost(costEstimation.materialCost)}
                  </p>
                </div>
                
                <div>
                  <p style={{ margin: 0, fontSize: '12px', color: 'rgba(255,255,255,0.6)' }}>
                    Labor ({costEstimation.estimatedHours}h)
                  </p>
                  <p style={{ margin: '4px 0 0 0', fontSize: '16px', color: '#fff', fontWeight: 500 }}>
                    {formatCost(costEstimation.laborCost)}
                  </p>
                </div>
              </div>
              
              <div style={{ 
                marginTop: '12px', 
                paddingTop: '12px', 
                borderTop: '1px solid rgba(255,255,255,0.1)' 
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '14px', color: 'rgba(255,255,255,0.8)' }}>
                    Total Estimated Cost
                  </span>
                  <span style={{ fontSize: '20px', color: '#10B981', fontWeight: 600 }}>
                    {formatCost(costEstimation.totalCost)}
                  </span>
                </div>
              </div>
              
              {costEstimation.notes && costEstimation.notes.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                  {costEstimation.notes.map((note, i) => (
                    <p key={i} style={{ 
                      margin: '2px 0', 
                      fontSize: '11px', 
                      color: 'rgba(255,255,255,0.5)' 
                    }}>
                      • {note}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={handleReset}
              style={{
                flex: 1,
                padding: '12px',
                backgroundColor: 'rgba(59, 130, 246, 0.3)',
                border: 'none',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '14px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              ➕ Create Another
            </button>
          </div>

          {model3dPath && (
            <p style={{ 
              fontSize: '12px', 
              color: 'rgba(255,255,255,0.5)', 
              margin: 0,
              textAlign: 'center',
            }}>
              ✅ 3D model saved and ready for placement
            </p>
          )}
        </div>
      )}

      {/* CSS Animations */}
      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.05); opacity: 0.8; }
        }
      `}</style>
    </div>
  );
};

export default RenovationPlannerPanel;
