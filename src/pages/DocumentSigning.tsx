import React, { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import SigningReceipt from '../components/SigningReceipt';
import './DocumentSigning.css';

interface Document {
  id: string;
  title: string;
  content: string;
  status: string;
  metadata: {
    icon: string;
    description: string;
  };
  signatureRequests?: SignatureRequest[];
  createdAt: string;
}

interface SignatureRequest {
  signerId: string;
  signerEmail: string;
  signerName: string;
  signerRole: string;
  token: string;
  status: 'pending' | 'signed';
  requestedAt: string;
  signedAt?: string;
}

interface Signer {
  id: string;
  firebaseUid?: string | null;
  email: string;
  name: string;
  role: string;
}

const DocumentSigning: React.FC = () => {
  const { documentId } = useParams<{ documentId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [document, setDocument] = useState<Document | null>(null);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [signed, setSigned] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [emailVerified, setEmailVerified] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [ersdAccepted, setErsdAccepted] = useState(false);
  const [ersdAcceptedAt, setErsdAcceptedAt] = useState<string | null>(null);

  // Signature canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const [saveSignatureForFuture, setSaveSignatureForFuture] = useState(false);
  const [showReceipt, setShowReceipt] = useState(false);
  const [signingReceiptId, setSigningReceiptId] = useState<string | null>(null);

  // Helper to get the signature storage ID (prefer Firebase UID for consistency)
  const getSignatureStorageId = () => {
    return signer?.firebaseUid || signer?.id || null;
  };

  useEffect(() => {
    if (documentId && token) {
      verifyAndLoadDocument();
    } else {
      setError('Invalid signing link. Please check the URL and try again.');
      setLoading(false);
    }
  }, [documentId, token]);

  // Fetch saved signature when signer is loaded
  useEffect(() => {
    const storageId = signer?.firebaseUid || signer?.id;
    if (storageId) {
      fetchSavedSignature(storageId);
    }
  }, [signer]);

  const fetchSavedSignature = async (signerId: string) => {
    try {
      const response = await fetch(`/api/signatures/${signerId}`);
      const data = await response.json();
      if (data.ok && data.hasSignature) {
        setSavedSignature(data.signature.signatureData);
        console.log('[DocumentSigning] Loaded saved signature for', signerId);
      }
    } catch (error) {
      console.error('[DocumentSigning] Error fetching saved signature:', error);
    }
  };

  const useSavedSignature = () => {
    if (savedSignature && canvasRef.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          setHasSignature(true);
        };
        img.src = savedSignature;
      }
    }
  };

  const deleteSavedSignature = async () => {
    const storageId = getSignatureStorageId();
    if (!storageId) return;
    try {
      await fetch(`/api/signatures/${storageId}`, { method: 'DELETE' });
      setSavedSignature(null);
      console.log('[DocumentSigning] Saved signature deleted');
    } catch (error) {
      console.error('[DocumentSigning] Error deleting saved signature:', error);
    }
  };

  useEffect(() => {
    // Initialize canvas context
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.strokeStyle = '#1e3a5f';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
    }
  }, [document]);

  const verifyAndLoadDocument = async () => {
    try {
      const response = await fetch(`/api/documents/sign/${documentId}?token=${token}`);
      const data = await response.json();

      if (!data.ok) {
        setError(data.error || 'Unable to access document');
        return;
      }

      setDocument(data.document);
      setSigner(data.signer);
    } catch (err) {
      console.error('Error loading document:', err);
      setError('Failed to load document. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setIsDrawing(true);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = ('touches' in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left) * scaleX;
    const y = ('touches' in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top) * scaleY;

    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = ('touches' in e ? e.touches[0].clientX - rect.left : e.clientX - rect.left) * scaleX;
    const y = ('touches' in e ? e.touches[0].clientY - rect.top : e.clientY - rect.top) * scaleY;

    ctx.lineTo(x, y);
    ctx.stroke();
    setHasSignature(true);
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  };

  const handleSign = async () => {
    if (!canvasRef.current || !hasSignature || !agreed) return;

    setSigning(true);
    try {
      const signatureData = canvasRef.current.toDataURL('image/png');

      // Save signature for future use if requested (use Firebase UID for consistency)
      const storageId = getSignatureStorageId();
      if (saveSignatureForFuture && storageId) {
        try {
          await fetch('/api/signatures/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: storageId,
              signatureData,
              name: signer?.name || 'Signature'
            })
          });
          setSavedSignature(signatureData);
          console.log('[DocumentSigning] Signature saved for future use');
        } catch (saveError) {
          console.error('Error saving signature:', saveError);
          // Continue with signing even if save fails
        }
      }

      const response = await fetch(`/api/documents/sign/${documentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          signatureData,
          ersdConsentTimestamp: ersdAcceptedAt
        })
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error);
      }

      // Capture signing receipt ID if all parties signed
      if (data.receiptId) {
        setSigningReceiptId(data.receiptId);
      }

      setSigned(true);
    } catch (err: any) {
      console.error('Error signing document:', err);
      alert(err.message || 'Failed to sign document');
    } finally {
      setSigning(false);
    }
  };

  if (loading) {
    return (
      <div className="signing-page loading">
        <div className="loading-spinner"></div>
        <p>Loading document...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="signing-page error">
        <div className="error-icon">⚠️</div>
        <h1>Unable to Access Document</h1>
        <p>{error}</p>
        <button onClick={() => navigate('/')} className="btn-primary">
          Go Home
        </button>
      </div>
    );
  }

  // Email verification gate - signer must confirm their identity
  if (document && signer && !emailVerified) {
    return (
      <div className="signing-page">
        <div className="signing-header">
          <div className="header-icon">🔐</div>
          <div className="header-content">
            <h1>Identity Verification</h1>
            <p className="header-meta">Please verify your identity before accessing this document</p>
          </div>
        </div>
        <div className="signing-body">
          <div className="signer-info-card">
            <h3>Verify Your Email Address</h3>
            <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '16px' }}>
              For security purposes, please enter your email address to confirm you are the intended signer. 
              This document was sent to <strong>{signer.email?.replace(/(.{2})(.*)(@.*)/, '$1***$3')}</strong>.
            </p>
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="Enter your email address"
              style={{ width: '100%', padding: '12px', border: '1px solid #d1d5db', borderRadius: '8px', fontSize: '16px', marginBottom: '12px' }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && emailInput.toLowerCase().trim() === signer.email?.toLowerCase().trim()) {
                  setEmailVerified(true);
                }
              }}
            />
            <button
              className="sign-btn"
              onClick={() => {
                if (emailInput.toLowerCase().trim() === signer.email?.toLowerCase().trim()) {
                  setEmailVerified(true);
                } else {
                  alert('The email address you entered does not match the intended signer for this document. Please check and try again.');
                }
              }}
              style={{ width: '100%' }}
            >
              ✅ Verify & Continue
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ERSD (Electronic Record and Signature Disclosure) consent gate
  if (document && signer && emailVerified && !ersdAccepted && !signed) {
    return (
      <div className="signing-page">
        <div className="signing-header">
          <div className="header-icon">📋</div>
          <div className="header-content">
            <h1>Electronic Record & Signature Disclosure</h1>
            <p className="header-meta">Please review and accept before signing</p>
          </div>
        </div>
        <div className="signing-body">
          <div className="ersd-step-card">
            <div className="ersd-step-badge">Step 1 of 2 — Disclosure Acceptance</div>
            <p className="ersd-step-intro">
              Before you can sign <strong>"{document.title}"</strong>, federal law requires that you
              review and consent to this Electronic Record and Signature Disclosure.
            </p>
            <div className="ersd-step-text">
              <p><strong>Federal ESIGN Act & UETA Disclosure</strong></p>
              <p>By proceeding with this electronic signature, you are consenting to conduct this transaction electronically in accordance with the U.S. Electronic Signatures in Global and National Commerce Act (ESIGN Act, 15 U.S.C. §7001 et seq.) and the Uniform Electronic Transactions Act (UETA).</p>
              <p><strong>1. Consent to Use Electronic Records and Signatures:</strong> You agree that your electronic signature on this document is legally binding and has the same legal effect as a handwritten signature. You consent to receive this document and any related notices electronically.</p>
              <p><strong>2. Right to Paper Copies:</strong> You have the right to receive a paper copy of any electronically signed document. To request a paper copy, contact the property owner/manager who sent this document or email support@myhouseyield.com. Paper copies will be provided at no charge.</p>
              <p><strong>3. Right to Withdraw Consent:</strong> You may withdraw your consent to receive electronic records at any time by contacting the property owner/manager or emailing support@myhouseyield.com. Withdrawal of consent will not affect the legal validity of any electronic signature already applied. After withdrawal, future documents will be provided in paper form.</p>
              <p><strong>4. Hardware & Software Requirements:</strong> To access and retain electronic records, you need: a device with internet access, a modern web browser (Chrome, Firefox, Safari, or Edge), and the ability to save or print documents for your records.</p>
              <p><strong>5. Record Retention:</strong> After signing, you will be able to download a copy of the signed document for your records. We recommend saving or printing a copy for your files. Signed documents are retained electronically and remain accessible through your portal.</p>
              <p><strong>6. Contact Information:</strong> To request paper copies, withdraw consent, or update your email address, contact HouseYield at support@myhouseyield.com.</p>
              <p><strong>Document Limitations:</strong> Certain documents (wills, codicils, testamentary trusts, and specific court-ordered documents) cannot be legally signed electronically. This platform is designed for residential rental and property management documents only.</p>
            </div>
            <button
              className="ersd-accept-btn"
              onClick={() => {
                setErsdAccepted(true);
                setErsdAcceptedAt(new Date().toISOString());
              }}
            >
              I Agree to Use Electronic Records and Signatures
            </button>
            <p className="ersd-step-decline-note">
              If you do not agree, you may close this page. Contact the document sender to arrange paper signing.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (signed) {
    return (
      <div className="signing-page success">
        <div className="success-icon">✅</div>
        <h1>Document Signed Successfully!</h1>
        <p>
          Thank you for signing "{document?.title}". 
          {signer?.role === 'tenant' 
            ? ' Your landlord will be notified and you will receive a copy once all parties have signed.'
            : ' You will receive a copy once all parties have signed.'}
        </p>
        <div className="success-details">
          <div className="detail-row">
            <span className="label">Document:</span>
            <span className="value">{document?.title}</span>
          </div>
          <div className="detail-row">
            <span className="label">Signed by:</span>
            <span className="value">{signer?.name}</span>
          </div>
          <div className="detail-row">
            <span className="label">Date:</span>
            <span className="value">{new Date().toLocaleString()}</span>
          </div>
        </div>
        
        {/* ESIGN Record Retention Notice */}
        <div style={{ margin: '20px 0', padding: '16px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '8px', fontSize: '13px', color: '#1e40af', textAlign: 'left' }}>
          <strong>📄 Record Retention Notice:</strong> Under the ESIGN Act, you have the right to retain a copy of this signed document. 
          We recommend downloading or printing a copy for your records. You can also access signed documents anytime from your tenant dashboard.
        </div>
        
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button 
            onClick={async () => {
              try {
                const response = await fetch(`/api/documents/${documentId}/signed`);
                const data = await response.json();
                if (data.ok && data.document?.contentWithSignatures) {
                  const blob = new Blob([data.document.contentWithSignatures], { type: 'text/plain' });
                  const url = URL.createObjectURL(blob);
                  const a = window.document.createElement('a');
                  a.href = url;
                  a.download = `${document?.title || 'signed-document'}_signed.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                } else {
                  alert('Document not ready for download yet. Please try again from your dashboard.');
                }
              } catch {
                alert('Unable to download. You can access signed documents from your dashboard.');
              }
            }}
            className="btn-secondary"
            style={{ background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer' }}
          >
            💾 Download Signed Copy
          </button>
          <button
            onClick={() => setShowReceipt(true)}
            className="btn-secondary"
            style={{ background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer' }}
          >
            📜 View Signing Receipt
          </button>
          <button onClick={() => navigate('/tenant/dashboard')} className="btn-primary">
            Return to Dashboard
          </button>
        </div>

        {/* Signing Receipt Modal */}
        {showReceipt && documentId && (
          <div style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999, padding: '20px', overflow: 'auto'
          }}>
            <div style={{ width: '100%', maxWidth: '940px', maxHeight: '90vh', overflow: 'auto', borderRadius: '12px' }}>
              <SigningReceipt
                documentId={documentId}
                receiptId={signingReceiptId || undefined}
                onClose={() => setShowReceipt(false)}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="signing-page">
      <div className="signing-header">
        <div className="header-icon">{document?.metadata?.icon || '📄'}</div>
        <div className="header-content">
          <h1>{document?.title}</h1>
          <p className="header-meta">
            Please review and sign this document
          </p>
        </div>
      </div>

      <div className="signing-body">
        {/* Signer info */}
        <div className="signer-info-card">
          <h3>Signing as:</h3>
          <div className="signer-details">
            <div className="signer-avatar">👤</div>
            <div>
              <div className="signer-name">{signer?.name}</div>
              <div className="signer-email">{signer?.email}</div>
              <div className="signer-role">{signer?.role}</div>
            </div>
          </div>
        </div>

        {/* Document content */}
        <div className="document-content-card">
          <h3>Document</h3>
          <div className="document-scroll">
            <pre>{document?.content}</pre>
          </div>
        </div>

        {/* Signature Status */}
        {document?.signatureRequests && document.signatureRequests.length > 1 && (
          <div className="signature-status-card">
            <h3>Signature Status</h3>
            <div className="status-list">
              {document.signatureRequests.map((req, index) => (
                <div 
                  key={index} 
                  className={`status-item ${req.status} ${req.signerId === signer?.id ? 'current' : ''}`}
                >
                  <span className="status-icon">
                    {req.status === 'signed' ? '✅' : req.signerId === signer?.id ? '✍️' : '⏳'}
                  </span>
                  <span className="status-name">{req.signerName}</span>
                  <span className="status-role">({req.signerRole})</span>
                  <span className="status-text">
                    {req.status === 'signed' 
                      ? 'Signed' 
                      : req.signerId === signer?.id 
                        ? 'Your turn' 
                        : 'Pending'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Signature input */}
        <div className="signature-input-card">
          <h3>Your Signature</h3>
          
          {/* Auto-Sign Option */}
          {savedSignature && (
            <div style={{ 
              marginBottom: '16px', 
              padding: '12px', 
              background: 'linear-gradient(135deg, #0d2818 0%, #1a4a2e 100%)', 
              borderRadius: '8px',
              border: '1px solid #22c55e'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontWeight: 600, color: '#22c55e' }}>✅ Saved Signature Available</span>
                <button 
                  style={{ 
                    fontSize: '12px', 
                    color: '#ef4444', 
                    background: 'none', 
                    border: 'none', 
                    cursor: 'pointer',
                    textDecoration: 'underline'
                  }}
                  onClick={deleteSavedSignature}
                >
                  Delete
                </button>
              </div>
              <button
                onClick={useSavedSignature}
                style={{
                  width: '100%',
                  padding: '10px 16px',
                  background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '14px'
                }}
              >
                ⚡ Use Saved Signature (Auto-Sign)
              </button>
            </div>
          )}
          
          <p className="signature-hint">
            {savedSignature ? 'Or draw a new signature below:' : 'Draw your signature below using your mouse or finger'}
          </p>
          
          <div className="canvas-container">
            <canvas
              ref={canvasRef}
              width={600}
              height={180}
              className="signature-canvas"
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
            />
            {!hasSignature && (
              <div className="canvas-placeholder">
                Sign here
              </div>
            )}
          </div>
          
          <button 
            className="clear-btn"
            onClick={clearSignature}
            disabled={!hasSignature}
          >
            Clear Signature
          </button>
          
          {/* Save for future checkbox */}
          {!savedSignature && hasSignature && (
            <div style={{ marginTop: '12px', display: 'flex', alignItems: 'center' }}>
              <input 
                type="checkbox" 
                id="save-signature" 
                checked={saveSignatureForFuture}
                onChange={(e) => setSaveSignatureForFuture(e.target.checked)}
                style={{ marginRight: '8px' }}
              />
              <label htmlFor="save-signature" style={{ color: '#9ca3af', fontSize: '14px' }}>
                💾 Save this signature for future documents
              </label>
              {saveSignatureForFuture && (
                <p style={{ fontSize: '11px', color: '#f59e0b', marginTop: '4px', marginLeft: '24px' }}>
                  ⚠️ Note: Even with a saved signature, you must review each document individually and confirm your intent to sign. A saved signature does not constitute automatic consent to future documents.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Legal agreement */}
        <div className="legal-agreement">
          <label className="checkbox-container">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span className="checkmark"></span>
            <span className="agreement-text">
              I have reviewed the document above and I intend to sign it. I understand that this electronic signature is legally binding and equivalent to my handwritten signature under the ESIGN Act and UETA.
            </span>
          </label>
        </div>

        {/* Submit button */}
        <button
          className="sign-btn"
          onClick={handleSign}
          disabled={!hasSignature || !agreed || signing}
        >
          {signing ? (
            <>
              <span className="spinner"></span>
              Signing...
            </>
          ) : (
            <>
              ✍️ Sign Document
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default DocumentSigning;
