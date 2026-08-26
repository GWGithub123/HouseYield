/**
 * Property Analysis Modal
 * Allows users to input property details and images for AI-powered investment analysis
 * Uses fine-tuned HouseYield-2 model for comprehensive property evaluation
 */

import React, { useState, useCallback } from 'react';

interface PropertyAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAnalysisComplete: (analysis: any) => void;
}

export const PropertyAnalysisModal: React.FC<PropertyAnalysisModalProps> = ({
  isOpen,
  onClose,
  onAnalysisComplete
}) => {
  const [address, setAddress] = useState('');
  const [listPrice, setListPrice] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'input' | 'analyzing' | 'complete'>('input');
  const [isDragging, setIsDragging] = useState(false);
  const [pasteSuccess, setPasteSuccess] = useState(false);

  const processFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;

    // Filter for image files and limit to 25 total
    const imageFiles = files.filter(file => file.type.startsWith('image/'));
    const newFiles = imageFiles.slice(0, 25 - images.length);
    
    if (newFiles.length === 0) {
      if (imageFiles.length === 0) {
        setError('Please upload image files only');
        setTimeout(() => setError(null), 3000);
      }
      return;
    }

    setImages(prev => [...prev, ...newFiles]);

    // Generate previews
    newFiles.forEach(file => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreviews(prev => [...prev, reader.result as string]);
      };
      reader.readAsDataURL(file);
    });

    // Show success notification
    setPasteSuccess(true);
    setTimeout(() => setPasteSuccess(false), 2000);
  }, [images.length]);

  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    processFiles(files);
  }, [processFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    processFiles(files);
  }, [processFiles]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (loading || step !== 'input') return;

    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    
    if (imageItems.length === 0) return;

    e.preventDefault();

    const files: File[] = [];
    imageItems.forEach(item => {
      const file = item.getAsFile();
      if (file) files.push(file);
    });

    processFiles(files);
  }, [loading, step, processFiles]);

  // Add paste event listener
  React.useEffect(() => {
    if (!isOpen || step !== 'input') return;

    const handlePasteEvent = (e: ClipboardEvent) => handlePaste(e);
    document.addEventListener('paste', handlePasteEvent);

    return () => {
      document.removeEventListener('paste', handlePasteEvent);
    };
  }, [isOpen, step, handlePaste]);

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
    setImagePreviews(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!address.trim()) {
      setError('Please enter a property address');
      return;
    }

    if (!listPrice || isNaN(Number(listPrice.replace(/[^0-9.-]/g, '')))) {
      setError('Please enter a valid listing price');
      return;
    }

    if (images.length === 0) {
      setError('Please upload at least one property image');
      return;
    }

    setError(null);
    setLoading(true);
    setStep('analyzing');

    try {
      // Convert images to base64
      const base64Images = await Promise.all(
        images.map(file => {
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
        })
      );

      const baseUrl = import.meta.env.VITE_PUSH_SERVER_URL || 'http://127.0.0.1:3001';
      
      console.log('[PropertyAnalysisModal] Calling HouseYield endpoint:', `${baseUrl}/api/houseyield-analysis`);
      
      // Call the HouseYield analysis endpoint
      const response = await fetch(`${baseUrl}/api/houseyield-analysis`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          address,
          listPrice: Number(listPrice.replace(/[^0-9.-]/g, '')),
          images: base64Images
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Analysis failed');
      }

      const result = await response.json();
      
      if (!result.ok) {
        throw new Error(result.error || 'Analysis failed');
      }

      setStep('complete');
      onAnalysisComplete(result);

    } catch (err) {
      console.error('[PropertyAnalysisModal] Error:', err);
      setError(err instanceof Error ? err.message : 'Failed to analyze property');
      setStep('input');
    } finally {
      setLoading(false);
    }
  };

  const resetForm = () => {
    setAddress('');
    setListPrice('');
    setImages([]);
    setImagePreviews([]);
    setError(null);
    setStep('input');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-6 border-b bg-gradient-to-r from-emerald-50 to-blue-50">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">
              {step === 'input' && 'Property Investment Analysis'}
              {step === 'analyzing' && 'Analyzing Property...'}
              {step === 'complete' && 'Analysis Complete'}
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              {step === 'input' && 'Enter property details for AI-powered investment evaluation'}
              {step === 'analyzing' && 'Our AI is analyzing the property using market data and vision AI'}
              {step === 'complete' && 'View your comprehensive investment analysis below'}
            </p>
          </div>
          <button
            onClick={() => {
              resetForm();
              onClose();
            }}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            disabled={loading}
          >
            <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8">
          {step === 'input' && (
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Address Input */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Property Address *
                </label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="e.g., 123 Main St, Austin, TX 78701"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  required
                  disabled={loading}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Full address helps us fetch accurate market data
                </p>
              </div>

              {/* List Price Input */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Current Listing Price *
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-3 text-gray-500 font-medium">$</span>
                  <input
                    type="text"
                    value={listPrice}
                    onChange={(e) => {
                      const value = e.target.value.replace(/[^0-9]/g, '');
                      setListPrice(value ? Number(value).toLocaleString() : '');
                    }}
                    placeholder="425,000"
                    className="w-full pl-8 pr-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    required
                    disabled={loading}
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Enter the current asking price for valuation analysis
                </p>
              </div>

              {/* Image Upload */}
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  Property Images * (up to 25)
                </label>
                <div 
                  className={`border-2 border-dashed rounded-lg p-6 text-center transition-all ${
                    isDragging 
                      ? 'border-emerald-500 bg-emerald-50' 
                      : 'border-gray-300 hover:border-emerald-400 bg-white'
                  } ${images.length >= 10 ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => document.getElementById('image-upload')?.click()}
                >
                  <input
                    type="file"
                    accept="image/*,image/png,image/jpeg,image/jpg,image/gif,image/webp,image/heic,image/heif"
                    multiple
                    onChange={handleImageUpload}
                    className="hidden"
                    id="image-upload"
                    disabled={loading || images.length >= 25}
                  />
                  <svg className="w-12 h-12 mx-auto mb-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  {isDragging ? (
                    <p className="text-sm font-medium text-emerald-600 mb-1">
                      Drop images here!
                    </p>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-gray-700 mb-1">
                        {images.length === 0 ? 'Click, drag & drop, or paste (Cmd+V) images' : `${images.length}/25 images uploaded`}
                      </p>
                      <p className="text-xs text-gray-500">
                        Upload photos of kitchens, bathrooms, bedrooms, and exterior
                      </p>
                      <p className="text-xs text-gray-400 mt-2">
                        Accepts: PNG, JPG, GIF, WebP, HEIC, and screenshots
                      </p>
                    </>
                  )}
                </div>

                {/* Image Previews */}
                {imagePreviews.length > 0 && (
                  <div className="grid grid-cols-5 gap-3 mt-4 max-h-96 overflow-y-auto">
                    {imagePreviews.map((preview, index) => (
                      <div key={index} className="relative group">
                        <img
                          src={preview}
                          alt={`Preview ${index + 1}`}
                          className="w-full h-24 object-cover rounded-lg border border-gray-200"
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(index)}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          disabled={loading}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                
                <p className="text-xs text-gray-500 mt-2">
                  Our AI will analyze these images to assess room conditions and suggest improvements
                </p>
              </div>

              {/* Paste Success Notification */}
              {pasteSuccess && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 flex items-center gap-2 animate-fade-in">
                  <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <p className="text-sm font-medium text-emerald-800">Images added successfully!</p>
                </div>
              )}

              {/* Error Message */}
              {error && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <div className="flex items-center gap-2">
                    <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-sm font-medium text-red-800">{error}</p>
                  </div>
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={loading || !address || !listPrice || images.length === 0}
                className="w-full bg-gradient-to-r from-emerald-600 to-blue-600 text-white font-semibold py-4 rounded-lg hover:from-emerald-700 hover:to-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                data-voice-id="analyze-property-btn"
              >
                {loading ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></div>
                    Analyzing...
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                    </svg>
                    Analyze Property
                  </>
                )}
              </button>
            </form>
          )}

          {step === 'analyzing' && (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="relative">
                <div className="animate-spin rounded-full h-24 w-24 border-4 border-emerald-200 border-t-emerald-600"></div>
                <svg className="absolute inset-0 m-auto w-12 h-12 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              
              <h3 className="text-xl font-bold text-gray-900 mt-6 mb-2">
                AI Analysis in Progress
              </h3>
              <p className="text-gray-600 text-center max-w-md mb-6">
                We're analyzing your property using our fine-tuned HouseYield-2 AI model
              </p>

              <div className="space-y-3 w-full max-w-md">
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-green-500 text-white flex items-center justify-center">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <span className="text-sm text-gray-700">Fetching ATTOM market data</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-green-500 text-white flex items-center justify-center">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <span className="text-sm text-gray-700">Analyzing images with Vision AI</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center animate-pulse">
                    <div className="w-2 h-2 bg-white rounded-full"></div>
                  </div>
                  <span className="text-sm text-gray-700">Running HouseYield-2 investment analysis</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
