import React, { useState, useEffect, useRef } from 'react';
import './SigningReceipt.css';

interface SignerEvent {
  name: string;
  email: string;
  role: string;
  securityLevel: string;
  authenticationMethod: string;
  signatureAdoption: string;
  signatureImage: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  status: string;
  sentAt: string | null;
  viewedAt: string | null;
  signedAt: string | null;
  esignConsent: {
    given: boolean;
    disclosureProvided: boolean;
    disclosureType: string;
    consentTimestamp: string | null;
  };
}

interface EnvelopeSummaryEvent {
  event: string;
  status: string;
  timestamp: string;
}

interface CarbonCopyEvent {
  name: string;
  email: string | null;
  role: string;
  status: string;
  sentAt: string | null;
}

interface SigningReceiptData {
  id: string;
  documentId: string;
  envelopeId: string;
  status: string;
  documentTitle: string;
  documentType: string;
  documentPages: number;
  certificatePages: number;
  signaturesCount: number;
  initialsCount: number;
  ownerId: string | null;
  tenantId: string | null;
  propertyId: string | null;
  envelopeOriginator: {
    name: string;
    address: string;
    email: string;
  };
  recordTracking: {
    status: string;
    createdAt: string;
    holder: string;
    holderEmail: string;
    location: string;
  };
  signerEvents: SignerEvent[];
  carbonCopyEvents: CarbonCopyEvent[];
  envelopeSummaryEvents: EnvelopeSummaryEvent[];
  integrityVerification: {
    contentHash: string;
    currentHash: string | null;
    sealedHash: string | null;
    sealedAt: string | null;
    tamperDetected: boolean;
    status: string;
    explanation: string;
    verifiedWith: string | null;
    verifiedWithLabel: string | null;
    verificationScope: string;
  };
  electronicRecordDisclosure: {
    createdAt: string;
    partiesAgreed: string;
    disclosureText: string;
  };
  createdAt: string;
  completedAt: string | null;
  autoNav: boolean;
  envelopeIdStamping: boolean;
  timeZone: string;
}

interface SigningReceiptProps {
  documentId: string;
  receiptId?: string;
  onClose?: () => void;
}

const SigningReceipt: React.FC<SigningReceiptProps> = ({ documentId, receiptId, onClose }) => {
  const [receipt, setReceipt] = useState<SigningReceiptData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showERSD, setShowERSD] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchReceipt();
  }, [documentId, receiptId]);

  const fetchReceipt = async () => {
    try {
      setLoading(true);
      const params = receiptId ? `?receiptId=${receiptId}` : '';
      const response = await fetch(`/api/documents/${documentId}/receipt${params}`);
      const data = await response.json();

      if (!data.ok) {
        // If no receipt exists yet, try to generate one
        if (response.status === 404) {
          const genResponse = await fetch(`/api/documents/${documentId}/receipt`, {
            method: 'POST'
          });
          const genData = await genResponse.json();
          if (genData.ok) {
            setReceipt(genData.receipt);
          } else {
            setError(genData.error || 'Unable to generate signing receipt');
          }
        } else {
          setError(data.error || 'Failed to load signing receipt');
        }
        return;
      }

      setReceipt(data.receipt);
    } catch (err) {
      console.error('[SigningReceipt] Error:', err);
      setError('Failed to load signing receipt');
    } finally {
      setLoading(false);
    }
  };

  const formatTimestamp = (ts: string | null): string => {
    if (!ts) return 'N/A';
    try {
      return new Date(ts).toLocaleString('en-US', {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
      });
    } catch {
      return ts;
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleDownload = () => {
    if (!receipt) return;

    // Build plain-text version of the receipt
    let text = '';
    text += '═══════════════════════════════════════════════════════════\n';
    text += '                 CERTIFICATE OF COMPLETION                \n';
    text += '═══════════════════════════════════════════════════════════\n\n';
    text += `Envelope Id: ${receipt.envelopeId}\n`;
    text += `Subject: ${receipt.documentTitle}\n`;
    text += `Status: ${receipt.status}\n\n`;
    text += `Document Pages: ${receipt.documentPages}           Signatures: ${receipt.signaturesCount}\n`;
    text += `Certificate Pages: ${receipt.certificatePages}      Initials: ${receipt.initialsCount}\n\n`;
    text += `Envelope Originator:\n`;
    text += `  ${receipt.envelopeOriginator.name}\n`;
    text += `  ${receipt.envelopeOriginator.address}\n`;
    text += `  ${receipt.envelopeOriginator.email}\n\n`;
    text += `AutoNav: ${receipt.autoNav ? 'Enabled' : 'Disabled'}\n`;
    text += `EnvelopeId Stamping: ${receipt.envelopeIdStamping ? 'Enabled' : 'Disabled'}\n`;
    text += `Time Zone: ${receipt.timeZone}\n\n`;

    text += '───────────────────────────────────────────────────────────\n';
    text += ' RECORD TRACKING\n';
    text += '───────────────────────────────────────────────────────────\n';
    text += `Status: ${receipt.recordTracking.status}\n`;
    text += `  ${formatTimestamp(receipt.recordTracking.createdAt)}\n`;
    text += `Holder: ${receipt.recordTracking.holder}\n`;
    text += `  ${receipt.recordTracking.holderEmail}\n`;
    text += `Location: ${receipt.recordTracking.location}\n\n`;

    text += '───────────────────────────────────────────────────────────\n';
    text += ' SIGNER EVENTS\n';
    text += '───────────────────────────────────────────────────────────\n';
    receipt.signerEvents.forEach(signer => {
      text += `\n${signer.name}\n`;
      text += `  ${signer.email}\n`;
      text += `  Security Level: ${signer.securityLevel}\n`;
      text += `  Signature Adoption: ${signer.signatureAdoption}\n`;
      text += `  IP Address: ${signer.ipAddress || 'N/A'}\n`;
      text += `  Sent:   ${formatTimestamp(signer.sentAt)}\n`;
      text += `  Viewed: ${formatTimestamp(signer.viewedAt)}\n`;
      text += `  Signed: ${formatTimestamp(signer.signedAt)}\n`;
      text += `  ESIGN Consent: ${signer.esignConsent.given ? 'Given' : 'Not Given'}\n`;
      text += `  Disclosure Provided: ${signer.esignConsent.disclosureProvided ? 'Yes' : 'No'}\n\n`;
    });

    if (receipt.carbonCopyEvents.length > 0) {
      text += '───────────────────────────────────────────────────────────\n';
      text += ' CARBON COPY EVENTS\n';
      text += '───────────────────────────────────────────────────────────\n';
      receipt.carbonCopyEvents.forEach(cc => {
        text += `\n${cc.name}\n`;
        text += `  ${cc.email || 'N/A'}\n`;
        text += `  ${cc.role}\n`;
        text += `  Status: ${cc.status}\n`;
        text += `  Sent: ${formatTimestamp(cc.sentAt)}\n\n`;
      });
    }

    text += '───────────────────────────────────────────────────────────\n';
    text += ' ENVELOPE SUMMARY EVENTS\n';
    text += '───────────────────────────────────────────────────────────\n';
    receipt.envelopeSummaryEvents.forEach(evt => {
      text += `  ${evt.event.padEnd(25)} ${evt.status.padEnd(20)} ${formatTimestamp(evt.timestamp)}\n`;
    });

    text += '\n───────────────────────────────────────────────────────────\n';
    text += ' DOCUMENT INTEGRITY\n';
    text += '───────────────────────────────────────────────────────────\n';
    text += `  Status: ${receipt.integrityVerification.status}\n`;
    text += `  Verification Scope: ${receipt.integrityVerification.verificationScope}\n`;
    if (receipt.integrityVerification.verifiedWithLabel) {
      text += `  Verified With: ${receipt.integrityVerification.verifiedWithLabel}\n`;
    }
    text += `  Document Content Hash: ${receipt.integrityVerification.contentHash}\n`;
    if (receipt.integrityVerification.currentHash) {
      text += `  Current Seal Hash: ${receipt.integrityVerification.currentHash}\n`;
    }
    if (receipt.integrityVerification.sealedHash) {
      text += `  Stored Completion Seal: ${receipt.integrityVerification.sealedHash}\n`;
      text += `  Sealed At: ${formatTimestamp(receipt.integrityVerification.sealedAt)}\n`;
    }
    text += `  Tamper Detected: ${receipt.integrityVerification.tamperDetected ? 'YES ⚠️' : 'No ✅'}\n`;
    text += `  Explanation: ${receipt.integrityVerification.explanation}\n`;

    text += '\n\n═══════════════════════════════════════════════════════════\n';
    text += ' ELECTRONIC RECORD AND SIGNATURE DISCLOSURE\n';
    text += '═══════════════════════════════════════════════════════════\n\n';
    text += receipt.electronicRecordDisclosure.disclosureText;
    text += '\n';

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = `signing_receipt_${receipt.documentId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="signing-receipt-container loading">
        <div className="receipt-loading-spinner" />
        <p>Loading signing receipt…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="signing-receipt-container error-state">
        <div className="receipt-error-icon">⚠️</div>
        <p>{error}</p>
        {onClose && (
          <button className="receipt-btn secondary" onClick={onClose}>Close</button>
        )}
      </div>
    );
  }

  if (!receipt) return null;

  return (
    <div className="signing-receipt-container" ref={printRef}>
      {/* Header bar */}
      <div className="receipt-header-bar">
        <div className="receipt-header-left">
          <span className="receipt-logo">🏠 HouseYield</span>
          <span className="receipt-title-badge">Certificate of Completion</span>
        </div>
        <div className="receipt-header-actions no-print">
          <button className="receipt-btn icon-btn" onClick={handlePrint} title="Print">
            🖨️
          </button>
          <button className="receipt-btn icon-btn" onClick={handleDownload} title="Download">
            💾
          </button>
          {onClose && (
            <button className="receipt-btn icon-btn" onClick={onClose} title="Close">
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Certificate of Completion header */}
      <div className="receipt-section certificate-header">
        <h2>Certificate of Completion</h2>
        <div className="cert-meta-grid">
          <div className="cert-meta-row">
            <span className="meta-label">Envelope Id:</span>
            <span className="meta-value">{receipt.envelopeId}</span>
          </div>
          <div className="cert-meta-row">
            <span className="meta-label">Subject:</span>
            <span className="meta-value">{receipt.documentTitle}</span>
          </div>
          <div className="cert-meta-row">
            <span className="meta-label">Status:</span>
            <span className={`meta-value status-badge ${receipt.status.toLowerCase()}`}>
              {receipt.status}
            </span>
          </div>
          <div className="cert-meta-row">
            <span className="meta-label">Source Envelope:</span>
            <span className="meta-value">—</span>
          </div>
          <div className="cert-meta-details">
            <div className="cert-col">
              <div>Document Pages: {receipt.documentPages}</div>
              <div>Certificate Pages: {receipt.certificatePages}</div>
              <div>AutoNav: {receipt.autoNav ? 'Enabled' : 'Disabled'}</div>
              <div>EnvelopeId Stamping: {receipt.envelopeIdStamping ? 'Enabled' : 'Disabled'}</div>
              <div>Time Zone: {receipt.timeZone}</div>
            </div>
            <div className="cert-col">
              <div>Signatures: {receipt.signaturesCount}</div>
              <div>Initials: {receipt.initialsCount}</div>
            </div>
            <div className="cert-col">
              <strong>Envelope Originator:</strong>
              <div>{receipt.envelopeOriginator.name}</div>
              <div>{receipt.envelopeOriginator.address}</div>
              <div>{receipt.envelopeOriginator.email}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Record Tracking */}
      <div className="receipt-section">
        <div className="section-header">Record Tracking</div>
        <div className="tracking-grid">
          <div className="tracking-item">
            <span className="tracking-label">Status:</span>
            <span className="tracking-value">{receipt.recordTracking.status}</span>
            <span className="tracking-date">{formatTimestamp(receipt.recordTracking.createdAt)}</span>
          </div>
          <div className="tracking-item">
            <span className="tracking-label">Holder:</span>
            <span className="tracking-value">{receipt.recordTracking.holder}</span>
            <span className="tracking-sub">{receipt.recordTracking.holderEmail}</span>
          </div>
          <div className="tracking-item">
            <span className="tracking-label">Location:</span>
            <span className="tracking-value">{receipt.recordTracking.location}</span>
          </div>
        </div>
      </div>

      {/* Signer Events */}
      <div className="receipt-section">
        <div className="section-header-row">
          <span className="section-col">Signer Events</span>
          <span className="section-col">Signature</span>
          <span className="section-col">Timestamp</span>
        </div>
        {receipt.signerEvents.map((signer, idx) => (
          <div key={idx} className={`signer-event-row ${signer.status}`}>
            <div className="signer-info-col">
              <div className="signer-name-line">{signer.name}</div>
              <div className="signer-email-line">{signer.email}</div>
              <div className="signer-detail">Security Level: {signer.securityLevel}</div>
              <div className={`signer-consent-badge ${signer.esignConsent.given ? 'accepted' : 'not-provided'}`}>
                <strong>Electronic Record and Signature Disclosure:</strong>
                <div style={{ marginLeft: '12px', marginTop: '2px' }}>
                  {signer.esignConsent.given
                    ? `Accepted: ${formatTimestamp(signer.esignConsent.consentTimestamp)}`
                    : 'Not Provided'}
                </div>
              </div>
            </div>
            <div className="signature-col">
              {signer.status === 'signed' ? (
                <div className="signature-block">
                  <div className="sig-label">Signed by:</div>
                  {signer.signatureImage ? (
                    <img
                      src={signer.signatureImage}
                      alt={`Signature of ${signer.name}`}
                      className="sig-image"
                    />
                  ) : (
                    <div className="sig-text">{signer.name}</div>
                  )}
                  <div className="sig-detail">Signature Adoption: {signer.signatureAdoption}</div>
                  <div className="sig-detail">Using IP Address: {signer.ipAddress || 'N/A'}</div>
                </div>
              ) : (
                <div className="pending-badge">⏳ Pending</div>
              )}
            </div>
            <div className="timestamp-col">
              {signer.sentAt && <div>Sent: {formatTimestamp(signer.sentAt)}</div>}
              {signer.viewedAt && <div>Viewed: {formatTimestamp(signer.viewedAt)}</div>}
              {signer.signedAt && <div>Signed: {formatTimestamp(signer.signedAt)}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Delivery Event Sections (placeholders like DocuSign) */}
      {[
        'In Person Signer Events',
        'Editor Delivery Events',
        'Agent Delivery Events',
        'Intermediary Delivery Events',
        'Certified Delivery Events'
      ].map(label => (
        <div key={label} className="receipt-section empty-section">
          <div className="section-header-row">
            <span className="section-col">{label}</span>
            <span className="section-col">{label.includes('Signer') ? 'Signature' : 'Status'}</span>
            <span className="section-col">Timestamp</span>
          </div>
        </div>
      ))}

      {/* Carbon Copy Events */}
      <div className="receipt-section">
        <div className="section-header-row">
          <span className="section-col">Carbon Copy Events</span>
          <span className="section-col">Status</span>
          <span className="section-col">Timestamp</span>
        </div>
        {receipt.carbonCopyEvents.length > 0 ? (
          receipt.carbonCopyEvents.map((cc, idx) => (
            <div key={idx} className="cc-event-row">
              <div className="cc-info-col">
                <div className="signer-name-line">{cc.name}</div>
                {cc.email && <div className="signer-email-line">{cc.email}</div>}
                <div className="signer-detail">{cc.role}</div>
                <div className="signer-detail">Security Level: Email, Account Authentication</div>
                <div className="signer-consent-badge not-required">
                  <strong>Electronic Record and Signature Disclosure:</strong>
                  <div style={{ marginLeft: '12px', marginTop: '2px' }}>Not Required (Carbon Copy Recipient)</div>
                </div>
              </div>
              <div className="cc-status-col">
                <span className="copied-badge">COPIED</span>
              </div>
              <div className="timestamp-col">
                {cc.sentAt && <div>Sent: {formatTimestamp(cc.sentAt)}</div>}
              </div>
            </div>
          ))
        ) : (
          <div className="empty-row">No carbon copy events</div>
        )}
      </div>

      {/* Witness & Notary (empty) */}
      {['Witness Events', 'Notary Events'].map(label => (
        <div key={label} className="receipt-section empty-section">
          <div className="section-header-row">
            <span className="section-col">{label}</span>
            <span className="section-col">Signature</span>
            <span className="section-col">Timestamp</span>
          </div>
        </div>
      ))}

      {/* Envelope Summary Events */}
      <div className="receipt-section">
        <div className="section-header-row">
          <span className="section-col">Envelope Summary Events</span>
          <span className="section-col">Status</span>
          <span className="section-col">Timestamps</span>
        </div>
        {receipt.envelopeSummaryEvents.map((evt, idx) => (
          <div key={idx} className="summary-event-row">
            <div className="summary-event-name">{evt.event}</div>
            <div className="summary-event-status">{evt.status}</div>
            <div className="summary-event-timestamp">{formatTimestamp(evt.timestamp)}</div>
          </div>
        ))}
      </div>

      {/* Payment Events (empty) */}
      <div className="receipt-section empty-section">
        <div className="section-header-row">
          <span className="section-col">Payment Events</span>
          <span className="section-col">Status</span>
          <span className="section-col">Timestamps</span>
        </div>
      </div>

      {/* Document Integrity */}
      <div className="receipt-section">
        <div className="section-header">Document Integrity Verification</div>
        <div className="integrity-grid">
          <div className={`integrity-status ${receipt.integrityVerification.tamperDetected ? 'failed' : 'verified'}`}>
            {receipt.integrityVerification.tamperDetected
              ? '⚠️ INTEGRITY CHECK FAILED — The current signed payload does not match the stored completion seal.'
              : '✅ Document integrity verified — The current signed payload still matches the stored completion seal.'}
          </div>
          <div className={`integrity-explanation ${receipt.integrityVerification.tamperDetected ? 'failed' : 'verified'}`}>
            {receipt.integrityVerification.explanation}
          </div>
          <div className="integrity-detail">
            <span>Verification Scope:</span>
            <span>{receipt.integrityVerification.verificationScope}</span>
          </div>
          {receipt.integrityVerification.verifiedWithLabel && (
            <div className="integrity-detail">
              <span>Verified With:</span>
              <span>{receipt.integrityVerification.verifiedWithLabel}</span>
            </div>
          )}
          <div className="integrity-detail">
            <span>Document Content Hash:</span>
            <code>{receipt.integrityVerification.contentHash}</code>
          </div>
          {receipt.integrityVerification.currentHash && (
            <div className="integrity-detail">
              <span>Current Seal Hash:</span>
              <code>{receipt.integrityVerification.currentHash}</code>
            </div>
          )}
          {receipt.integrityVerification.sealedHash && (
            <>
              <div className="integrity-detail">
                <span>Stored Completion Seal:</span>
                <code>{receipt.integrityVerification.sealedHash}</code>
              </div>
              <div className="integrity-detail">
                <span>Sealed At:</span>
                <span>{formatTimestamp(receipt.integrityVerification.sealedAt)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Electronic Record and Signature Disclosure */}
      <div className="receipt-section ersd-section">
        <div
          className="section-header clickable"
          onClick={() => setShowERSD(!showERSD)}
        >
          Electronic Record and Signature Disclosure
          <span className="toggle-icon">{showERSD ? '▼' : '▶'}</span>
        </div>
        {showERSD && (
          <div className="ersd-content">
            <div className="ersd-meta">
              <div>Created on: {formatTimestamp(receipt.electronicRecordDisclosure.createdAt)}</div>
              <div>Parties agreed to: {receipt.electronicRecordDisclosure.partiesAgreed}</div>
            </div>
            <div className="ersd-text">
              {receipt.electronicRecordDisclosure.disclosureText.split('\n\n').map((para, idx) => (
                <p key={idx}>{para}</p>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="receipt-footer">
        <div className="footer-line">
          Receipt ID: {receipt.id}
        </div>
        <div className="footer-line">
          Generated: {formatTimestamp(receipt.createdAt)}
        </div>
        <div className="footer-legal">
          This document was electronically signed in accordance with the U.S. Electronic Signatures
          in Global and National Commerce Act (ESIGN Act, 15 U.S.C. §7001 et seq.) and the Uniform
          Electronic Transactions Act (UETA). Electronic signatures on this document are legally
          binding and enforceable.
        </div>
      </div>
    </div>
  );
};

export default SigningReceipt;
