import React, { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import './DocumentScanner.css';

interface ScannedDocument {
  id: string;
  dataUrl: string;
  timestamp: Date;
  fileName: string;
}

interface OCRResult {
  processed: boolean;
  textLength: number;
  pageCount: number;
}

interface ClassificationResult {
  type: string;
  confidence: number;
  extractedFields: {
    date?: string;
    amount?: string;
    parties?: string[];
    address?: string;
  };
}

interface UploadResult {
  ocr: OCRResult;
  classification: ClassificationResult;
  pdf: {
    generated: boolean;
    url: string | null;
  };
}

const DocumentScanner: React.FC = () => {
  const [searchParams] = useSearchParams();
  
  // Get params from URL
  const ownerId = searchParams.get('ownerId');
  const propertyId = searchParams.get('propertyId');
  const sessionToken = searchParams.get('session');

  // State
  const [isCapturing, setIsCapturing] = useState(false);
  const [scannedDocuments, setScannedDocuments] = useState<ScannedDocument[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [documentTitle, setDocumentTitle] = useState('');
  const [propertyAddress, setPropertyAddress] = useState('');
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Validate session on mount
  useEffect(() => {
    if (!ownerId || !propertyId || !sessionToken) {
      setError('Invalid scanner link. Please generate a new link from the Document Center.');
      return;
    }
    
    // Fetch property details
    fetchPropertyDetails();
  }, [ownerId, propertyId, sessionToken]);

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [stream]);

  const fetchPropertyDetails = async () => {
    try {
      const response = await fetch(`/api/properties/${propertyId}`);
      if (response.ok) {
        const data = await response.json();
        if (data.ok && data.property) {
          setPropertyAddress(data.property.address || 'Unknown Property');
        }
      }
    } catch (err) {
      console.error('Failed to fetch property details:', err);
    }
  };

  const startCamera = async () => {
    try {
      setError(null);
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment', // Use back camera
          width: { ideal: 1920 },
          height: { ideal: 1080 }
        }
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play();
      }
      
      setStream(mediaStream);
      setCameraActive(true);
    } catch (err: any) {
      console.error('Camera error:', err);
      setError('Could not access camera. Please ensure camera permissions are granted.');
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    setCameraActive(false);
  };

  const captureImage = () => {
    if (!videoRef.current || !canvasRef.current) return;

    setIsCapturing(true);
    
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    
    if (!context) return;

    // Set canvas size to match video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // Draw the video frame to canvas
    context.drawImage(video, 0, 0);
    
    // Get the image data
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    
    // Add to scanned documents
    const newDoc: ScannedDocument = {
      id: `scan_${Date.now()}`,
      dataUrl,
      timestamp: new Date(),
      fileName: `scan_${new Date().toISOString().slice(0, 10)}_${scannedDocuments.length + 1}.jpg`
    };
    
    setScannedDocuments(prev => [...prev, newDoc]);
    setIsCapturing(false);
    
    // Flash effect feedback
    if (videoRef.current) {
      videoRef.current.style.opacity = '0.5';
      setTimeout(() => {
        if (videoRef.current) videoRef.current.style.opacity = '1';
      }, 100);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    Array.from(files).forEach(file => {
      if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
        setError('Please select image or PDF files only.');
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const newDoc: ScannedDocument = {
          id: `upload_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          dataUrl: reader.result as string,
          timestamp: new Date(),
          fileName: file.name
        };
        setScannedDocuments(prev => [...prev, newDoc]);
      };
      reader.readAsDataURL(file);
    });

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeDocument = (id: string) => {
    setScannedDocuments(prev => prev.filter(doc => doc.id !== id));
  };

  const uploadDocuments = async () => {
    if (scannedDocuments.length === 0) {
      setError('Please scan or upload at least one document.');
      return;
    }

    if (!documentTitle.trim()) {
      setError('Please enter a document title.');
      return;
    }

    setUploading(true);
    setUploadProgress(0);
    setUploadStage('Preparing document...');
    setError(null);
    setUploadResult(null);

    try {
      // Prepare the document data
      const documentData = {
        ownerId,
        propertyId,
        sessionToken,
        title: documentTitle.trim(),
        documentType: 'scanned_document',
        scannedPages: scannedDocuments.map((doc, index) => ({
          pageNumber: index + 1,
          dataUrl: doc.dataUrl,
          fileName: doc.fileName,
          scannedAt: doc.timestamp.toISOString()
        })),
        metadata: {
          icon: '📄',
          description: 'Scanned document',
          isScanned: true,
          scanSource: 'mobile',
          pageCount: scannedDocuments.length,
          scannedAt: new Date().toISOString()
        }
      };

      setUploadProgress(10);
      setUploadStage('Uploading images...');

      // Simulate progress during upload
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev < 30) return prev + 2;
          if (prev < 50) {
            setUploadStage('Extracting text (OCR)...');
            return prev + 1;
          }
          if (prev < 70) {
            setUploadStage('Classifying document...');
            return prev + 1;
          }
          if (prev < 85) {
            setUploadStage('Generating PDF...');
            return prev + 1;
          }
          return prev;
        });
      }, 200);

      const response = await fetch('/api/documents/scanned', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(documentData)
      });

      clearInterval(progressInterval);
      setUploadProgress(95);
      setUploadStage('Finalizing...');

      const result = await response.json();

      if (!result.ok) {
        throw new Error(result.error || 'Failed to upload document');
      }

      setUploadProgress(100);
      setUploadStage('Complete!');
      
      // Store the OCR and classification results
      setUploadResult({
        ocr: result.ocr,
        classification: result.classification,
        pdf: result.pdf
      });
      
      // Format classification type for display
      const classType = result.classification?.type?.replace(/_/g, ' ') || 'document';
      setSuccess(`✅ Document saved! Classified as "${classType}" with ${result.ocr?.textLength || 0} characters extracted.`);
      
      // Clear scanned documents after successful upload
      setScannedDocuments([]);
      setDocumentTitle('');

    } catch (err: any) {
      console.error('Upload error:', err);
      setError(err.message || 'Failed to upload document. Please try again.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  // Show error if invalid session
  if (!ownerId || !propertyId || !sessionToken) {
    return (
      <div className="document-scanner-page error-page">
        <div className="error-container">
          <div className="error-icon">⚠️</div>
          <h1>Invalid Scanner Link</h1>
          <p>This scanner link is invalid or has expired.</p>
          <p>Please generate a new link from the Document Center on your desktop.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="document-scanner-page">
      {/* Header */}
      <header className="scanner-header">
        <h1>📷 Document Scanner</h1>
        <p className="property-info">
          Property: <strong>{propertyAddress || 'Loading...'}</strong>
        </p>
      </header>

      {/* Error/Success Messages */}
      {error && (
        <div className="alert alert-error">
          <span className="alert-icon">⚠️</span>
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      {success && (
        <div className="alert alert-success">
          <span className="alert-icon">✅</span>
          <span>{success}</span>
          <button onClick={() => { setSuccess(null); setUploadResult(null); }}>×</button>
        </div>
      )}

      {/* OCR Results Display */}
      {uploadResult && (
        <div className="ocr-results-section">
          <h3>📄 Document Processing Results</h3>
          
          <div className="results-grid">
            <div className="result-card classification">
              <div className="result-icon">🏷️</div>
              <div className="result-content">
                <div className="result-label">Document Type</div>
                <div className="result-value">{uploadResult.classification.type.replace(/_/g, ' ')}</div>
                <div className="result-confidence">
                  {Math.round(uploadResult.classification.confidence * 100)}% confidence
                </div>
              </div>
            </div>
            
            <div className="result-card ocr">
              <div className="result-icon">📝</div>
              <div className="result-content">
                <div className="result-label">Text Extracted</div>
                <div className="result-value">{uploadResult.ocr.textLength.toLocaleString()} characters</div>
                <div className="result-pages">{uploadResult.ocr.pageCount} page(s)</div>
              </div>
            </div>
            
            {uploadResult.pdf.generated && (
              <div className="result-card pdf">
                <div className="result-icon">📑</div>
                <div className="result-content">
                  <div className="result-label">PDF Generated</div>
                  <a 
                    href={uploadResult.pdf.url || '#'} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="pdf-download-link"
                  >
                    📥 Download PDF
                  </a>
                </div>
              </div>
            )}
          </div>
          
          {uploadResult.classification.extractedFields && Object.keys(uploadResult.classification.extractedFields).length > 0 && (
            <div className="extracted-fields">
              <h4>📋 Extracted Information</h4>
              <div className="fields-list">
                {uploadResult.classification.extractedFields.date && (
                  <div className="field-item">
                    <span className="field-label">Date:</span>
                    <span className="field-value">{uploadResult.classification.extractedFields.date}</span>
                  </div>
                )}
                {uploadResult.classification.extractedFields.amount && (
                  <div className="field-item">
                    <span className="field-label">Amount:</span>
                    <span className="field-value">{uploadResult.classification.extractedFields.amount}</span>
                  </div>
                )}
                {uploadResult.classification.extractedFields.address && (
                  <div className="field-item">
                    <span className="field-label">Address:</span>
                    <span className="field-value">{uploadResult.classification.extractedFields.address}</span>
                  </div>
                )}
                {uploadResult.classification.extractedFields.parties && uploadResult.classification.extractedFields.parties.length > 0 && (
                  <div className="field-item">
                    <span className="field-label">Parties:</span>
                    <span className="field-value">{uploadResult.classification.extractedFields.parties.join(', ')}</span>
                  </div>
                )}
              </div>
            </div>
          )}
          
          <button 
            className="btn-scan-another"
            onClick={() => { setUploadResult(null); setSuccess(null); }}
          >
            📷 Scan Another Document
          </button>
        </div>
      )}

      {/* Camera Section */}
      <div className="camera-section">
        {cameraActive ? (
          <div className="camera-container">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="camera-feed"
            />
            <div className="camera-overlay">
              <div className="scan-guide"></div>
            </div>
            <div className="camera-controls">
              <button 
                className="btn-capture"
                onClick={captureImage}
                disabled={isCapturing}
              >
                {isCapturing ? '📸' : '📷'} Capture
              </button>
              <button 
                className="btn-stop"
                onClick={stopCamera}
              >
                ✕ Close Camera
              </button>
            </div>
          </div>
        ) : (
          <div className="camera-placeholder">
            <div className="placeholder-content">
              <div className="placeholder-icon">📷</div>
              <p>Use your phone's camera to scan documents</p>
              <div className="scan-options">
                <button 
                  className="btn-start-camera"
                  onClick={startCamera}
                >
                  📸 Open Camera
                </button>
                <span className="or-divider">or</span>
                <button 
                  className="btn-upload-file"
                  onClick={() => fileInputRef.current?.click()}
                >
                  📁 Choose from Gallery
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Hidden canvas for capturing */}
      <canvas ref={canvasRef} style={{ display: 'none' }} />

      {/* Scanned Documents Preview */}
      {scannedDocuments.length > 0 && (
        <div className="scanned-documents-section">
          <h3>📄 Scanned Pages ({scannedDocuments.length})</h3>
          <div className="scanned-thumbnails">
            {scannedDocuments.map((doc, index) => (
              <div key={doc.id} className="thumbnail-card">
                <div className="thumbnail-image">
                  <img src={doc.dataUrl} alt={`Page ${index + 1}`} />
                  <span className="page-number">Page {index + 1}</span>
                </div>
                <button 
                  className="remove-btn"
                  onClick={() => removeDocument(doc.id)}
                  title="Remove"
                >
                  ×
                </button>
              </div>
            ))}
            <div 
              className="add-more-card"
              onClick={() => cameraActive ? captureImage() : startCamera()}
            >
              <span className="add-icon">+</span>
              <span>Add Page</span>
            </div>
          </div>
        </div>
      )}

      {/* Document Details & Upload */}
      {scannedDocuments.length > 0 && (
        <div className="upload-section">
          <div className="form-group">
            <label>Document Title *</label>
            <input
              type="text"
              placeholder="e.g., Lease Agreement, Insurance Certificate, etc."
              value={documentTitle}
              onChange={(e) => setDocumentTitle(e.target.value)}
              className="form-input"
            />
          </div>

          {uploading && (
            <div className="upload-progress">
              <div className="progress-bar">
                <div 
                  className="progress-fill" 
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
              <span className="progress-text">{uploadStage} {uploadProgress}%</span>
            </div>
          )}

          <button
            className="btn-upload-document"
            onClick={uploadDocuments}
            disabled={uploading || !documentTitle.trim()}
          >
            {uploading ? '⏳ Uploading...' : '📤 Save Document'}
          </button>
        </div>
      )}

      {/* Help Section */}
      <div className="help-section">
        <h4>📋 Tips for Best Results</h4>
        <ul>
          <li>Ensure good lighting on the document</li>
          <li>Hold your phone steady and parallel to the document</li>
          <li>Make sure all edges of the document are visible</li>
          <li>For multi-page documents, capture each page separately</li>
        </ul>
      </div>
    </div>
  );
};

export default DocumentScanner;
