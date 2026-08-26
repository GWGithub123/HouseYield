import React, { useState, useEffect } from 'react';
import './LeaseBuilder.css';
import { RentersInsurancePolicy } from '../types/insurance';

interface LeaseSection {
  title: string;
  baseline: string;
  customizable: boolean;
}

interface LeaseSections {
  [key: string]: LeaseSection;
}

interface LeaseConfig {
  propertyAddress: string;
  landlordName: string;
  tenantName: string;
  startDate: string;
  duration: string;
  rentAmount: string;
  securityDeposit: string;
  dueDate?: string;
  paymentMethod?: string;
  lateFee?: string;
  gracePeriod?: string;
  returnDays?: string;
  tenantUtilities?: string;
  landlordUtilities?: string;
  minorRepairLimit?: string;
  numberOccupants?: string;
  petDeposit?: string;
  petRent?: string;
  noticeHours?: string;
  terminationNotice?: string;
  disclosures?: string;
  rentersInsurance?: RentersInsurancePolicy;
  customSections?: {
    [key: string]: string;
  };
}

interface GeneratedLease {
  metadata: any;
  sections: {
    [key: string]: {
      title: string;
      content: string;
    };
  };
}

const LeaseBuilder: React.FC = () => {
  const [template, setTemplate] = useState<LeaseSections | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [activeSection, setActiveSection] = useState<string>('');
  const [generatedLease, setGeneratedLease] = useState<GeneratedLease | null>(null);
  const [summary, setSummary] = useState<string>('');
  const [insuranceFile, setInsuranceFile] = useState<File | null>(null);
  const [parsingInsurance, setParsingInsurance] = useState(false);
  const [parsedInsurance, setParsedInsurance] = useState<RentersInsurancePolicy | null>(null);
  const [config, setConfig] = useState<LeaseConfig>({
    propertyAddress: '',
    landlordName: '',
    tenantName: '',
    startDate: '',
    duration: '12',
    rentAmount: '',
    securityDeposit: '',
    dueDate: '1',
    paymentMethod: 'bank transfer or check',
    lateFee: '50',
    gracePeriod: '5',
    returnDays: '30',
    tenantUtilities: 'electricity, gas, water, internet',
    landlordUtilities: 'trash collection, common area maintenance',
    minorRepairLimit: '100',
    numberOccupants: '0',
    petDeposit: '500',
    petRent: '50',
    noticeHours: '24',
    terminationNotice: '30',
    disclosures: 'None',
    customSections: {}
  });

  useEffect(() => {
    fetchTemplate();
  }, []);

  const fetchTemplate = async () => {
    try {
      const response = await fetch('/api/lease/template');
      const data = await response.json();
      if (data.ok) {
        setTemplate(data.sections);
      }
    } catch (error) {
      console.error('Error fetching template:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleConfigChange = (field: keyof LeaseConfig, value: string) => {
    setConfig(prev => ({ ...prev, [field]: value }));
  };

  const handleCustomSectionChange = (sectionKey: string, value: string) => {
    setConfig(prev => ({
      ...prev,
      customSections: {
        ...prev.customSections,
        [sectionKey]: value
      }
    }));
  };

  const validateCustomSection = async (sectionKey: string, text: string) => {
    if (!text.trim()) return;

    try {
      const response = await fetch('/api/lease/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionKey, customText: text })
      });
      const data = await response.json();
      
      if (data.ok && !data.approved) {
        alert(`⚠️ Validation Warning:\n\n${data.message}`);
      }
    } catch (error) {
      console.error('Validation error:', error);
    }
  };

  const handleInsuranceUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setInsuranceFile(file);
    setParsingInsurance(true);
    setParsedInsurance(null);

    try {
      // Convert file to base64
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Data = reader.result as string;

        // Call parsing API
        const response = await fetch('/api/lease/parse-insurance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageData: base64Data })
        });

        const data = await response.json();
        if (data.ok && data.policy) {
          setParsedInsurance(data.policy);
          // Update config with insurance data
          setConfig(prev => ({
            ...prev,
            rentersInsurance: data.policy
          }));
          alert('✅ Insurance policy successfully parsed!');
        } else {
          alert(`❌ Failed to parse insurance: ${data.error}`);
        }
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error('Insurance upload error:', error);
      alert('Failed to process insurance document');
    } finally {
      setParsingInsurance(false);
    }
  };

  const generateLease = async () => {
    setGenerating(true);
    setGeneratedLease(null);
    setSummary('');

    try {
      const response = await fetch('/api/lease/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await response.json();

      if (data.ok && data.lease) {
        setGeneratedLease(data.lease);
        // Generate summary
        const summaryResponse = await fetch('/api/lease/summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lease: data.lease })
        });
        const summaryData = await summaryResponse.json();
        if (summaryData.ok) {
          setSummary(summaryData.summary);
        }
      } else {
        alert(`Error generating lease: ${data.error}`);
      }
    } catch (error) {
      console.error('Error generating lease:', error);
      alert('Failed to generate lease. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const exportToText = () => {
    if (!generatedLease) return;

    let content = '═══════════════════════════════════════════════════════\n';
    content += '           RESIDENTIAL LEASE AGREEMENT\n';
    content += '═══════════════════════════════════════════════════════\n\n';

    Object.entries(generatedLease.sections).forEach(([, section]) => {
      content += `${section.title.toUpperCase()}\n`;
      content += '─'.repeat(60) + '\n\n';
      content += `${section.content}\n\n\n`;
    });

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lease-agreement-${config.propertyAddress.replace(/[^a-z0-9]/gi, '_')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = () => {
    if (!generatedLease) return;

    let content = '';
    Object.entries(generatedLease.sections).forEach(([, section]) => {
      content += `${section.title.toUpperCase()}\n\n${section.content}\n\n\n`;
    });

    navigator.clipboard.writeText(content);
    alert('Lease agreement copied to clipboard!');
  };

  if (loading) {
    return <div className="lease-builder-loading">Loading lease template...</div>;
  }

  return (
    <div className="lease-builder">
      <div className="lease-builder-header">
        <h1>🏠 AI Lease Agreement Builder</h1>
        <p>Create a professional lease agreement with AI-powered customization</p>
      </div>

      {!generatedLease ? (
        <div className="lease-builder-form">
          {/* Basic Information */}
          <section className="form-section">
            <h2>📋 Basic Information</h2>
            <div className="form-grid">
              <div className="form-field">
                <label>Property Address *</label>
                <input
                  type="text"
                  value={config.propertyAddress}
                  onChange={(e) => handleConfigChange('propertyAddress', e.target.value)}
                  placeholder="123 Main St, City, State ZIP"
                  required
                />
              </div>
              <div className="form-field">
                <label>Landlord Name *</label>
                <input
                  type="text"
                  value={config.landlordName}
                  onChange={(e) => handleConfigChange('landlordName', e.target.value)}
                  placeholder="John Doe"
                  required
                />
              </div>
              <div className="form-field">
                <label>Tenant Name *</label>
                <input
                  type="text"
                  value={config.tenantName}
                  onChange={(e) => handleConfigChange('tenantName', e.target.value)}
                  placeholder="Jane Smith"
                  required
                />
              </div>
              <div className="form-field">
                <label>Start Date *</label>
                <input
                  type="date"
                  value={config.startDate}
                  onChange={(e) => handleConfigChange('startDate', e.target.value)}
                  required
                />
              </div>
              <div className="form-field">
                <label>Duration (months) *</label>
                <input
                  type="number"
                  value={config.duration}
                  onChange={(e) => handleConfigChange('duration', e.target.value)}
                  min="1"
                  required
                />
              </div>
              <div className="form-field">
                <label>Monthly Rent ($) *</label>
                <input
                  type="number"
                  value={config.rentAmount}
                  onChange={(e) => handleConfigChange('rentAmount', e.target.value)}
                  placeholder="1500"
                  min="0"
                  required
                />
              </div>
              <div className="form-field">
                <label>Security Deposit ($) *</label>
                <input
                  type="number"
                  value={config.securityDeposit}
                  onChange={(e) => handleConfigChange('securityDeposit', e.target.value)}
                  placeholder="1500"
                  min="0"
                  required
                />
              </div>
            </div>
          </section>

          {/* Additional Details */}
          <section className="form-section collapsible">
            <h2>⚙️ Additional Details (Optional)</h2>
            <div className="form-grid">
              <div className="form-field">
                <label>Rent Due Date (day of month)</label>
                <input
                  type="number"
                  value={config.dueDate}
                  onChange={(e) => handleConfigChange('dueDate', e.target.value)}
                  min="1"
                  max="31"
                />
              </div>
              <div className="form-field">
                <label>Payment Method</label>
                <input
                  type="text"
                  value={config.paymentMethod}
                  onChange={(e) => handleConfigChange('paymentMethod', e.target.value)}
                />
              </div>
              <div className="form-field">
                <label>Late Fee ($)</label>
                <input
                  type="number"
                  value={config.lateFee}
                  onChange={(e) => handleConfigChange('lateFee', e.target.value)}
                  min="0"
                />
              </div>
              <div className="form-field">
                <label>Grace Period (days)</label>
                <input
                  type="number"
                  value={config.gracePeriod}
                  onChange={(e) => handleConfigChange('gracePeriod', e.target.value)}
                  min="0"
                />
              </div>
              <div className="form-field">
                <label>Number of Additional Occupants</label>
                <input
                  type="number"
                  value={config.numberOccupants}
                  onChange={(e) => handleConfigChange('numberOccupants', e.target.value)}
                  min="0"
                />
              </div>
              <div className="form-field">
                <label>Notice Hours for Entry</label>
                <input
                  type="number"
                  value={config.noticeHours}
                  onChange={(e) => handleConfigChange('noticeHours', e.target.value)}
                  min="0"
                />
              </div>
              <div className="form-field">
                <label>Termination Notice (days)</label>
                <input
                  type="number"
                  value={config.terminationNotice}
                  onChange={(e) => handleConfigChange('terminationNotice', e.target.value)}
                  min="0"
                />
              </div>
            </div>
          </section>

          {/* Renter's Insurance Upload */}
          <section className="form-section">
            <h2>🛡️ Renter's Insurance (Optional)</h2>
            <p className="section-description">
              Upload the tenant's Certificate of Insurance (COI) to automatically extract policy details.
            </p>
            
            <div style={{ marginBottom: '20px' }}>
              <label className="upload-label">
                <div style={{
                  border: '2px dashed #d1d5db',
                  borderRadius: '8px',
                  padding: '30px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  backgroundColor: parsingInsurance ? '#f3f4f6' : '#ffffff',
                  transition: 'all 0.2s'
                }}>
                  {parsingInsurance ? (
                    <>
                      <div style={{ fontSize: '40px', marginBottom: '10px' }}>⏳</div>
                      <p style={{ color: '#6b7280', margin: 0 }}>Parsing insurance document...</p>
                    </>
                  ) : parsedInsurance ? (
                    <>
                      <div style={{ fontSize: '40px', marginBottom: '10px' }}>✅</div>
                      <p style={{ color: '#059669', fontWeight: 'bold', margin: 0 }}>Insurance Uploaded</p>
                      <p style={{ color: '#6b7280', margin: '5px 0 0 0', fontSize: '14px' }}>Click to upload a different document</p>
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: '40px', marginBottom: '10px' }}>📄</div>
                      <p style={{ color: '#374151', fontWeight: 'bold', margin: 0 }}>Click to Upload Certificate of Insurance</p>
                      <p style={{ color: '#6b7280', margin: '5px 0 0 0', fontSize: '14px' }}>Supported: PDF, JPG, PNG</p>
                    </>
                  )}
                </div>
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={handleInsuranceUpload}
                  style={{ display: 'none' }}
                  disabled={parsingInsurance}
                />
              </label>
            </div>

            {parsedInsurance && (
              <div style={{
                backgroundColor: '#ecfdf5',
                border: '1px solid #10b981',
                borderRadius: '8px',
                padding: '20px',
                marginTop: '15px'
              }}>
                <h3 style={{ marginTop: 0, color: '#065f46', fontSize: '16px' }}>📋 Parsed Insurance Details</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', fontSize: '14px' }}>
                  <div>
                    <strong style={{ color: '#064e3b' }}>Insurance Company:</strong>
                    <div style={{ color: '#047857' }}>{parsedInsurance.insuranceCompany}</div>
                  </div>
                  <div>
                    <strong style={{ color: '#064e3b' }}>Policy Number:</strong>
                    <div style={{ color: '#047857' }}>{parsedInsurance.policyNumber}</div>
                  </div>
                  <div>
                    <strong style={{ color: '#064e3b' }}>Policy Holder:</strong>
                    <div style={{ color: '#047857' }}>{parsedInsurance.policyHolder}</div>
                  </div>
                  <div>
                    <strong style={{ color: '#064e3b' }}>Liability Coverage:</strong>
                    <div style={{ color: '#047857' }}>
                      {parsedInsurance.coverageAmount.liability 
                        ? `$${parsedInsurance.coverageAmount.liability.toLocaleString()}` 
                        : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <strong style={{ color: '#064e3b' }}>Personal Property:</strong>
                    <div style={{ color: '#047857' }}>
                      {parsedInsurance.coverageAmount.personalProperty 
                        ? `$${parsedInsurance.coverageAmount.personalProperty.toLocaleString()}` 
                        : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <strong style={{ color: '#064e3b' }}>Expiration Date:</strong>
                    <div style={{ color: '#047857' }}>
                      {new Date(parsedInsurance.expirationDate).toLocaleDateString()}
                    </div>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <strong style={{ color: '#064e3b' }}>Landlord Listed as Interested Party:</strong>
                    <div style={{ color: '#047857' }}>
                      {parsedInsurance.landlordListedAsInterested ? '✅ Yes' : '❌ No'}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Custom Sections */}
          <section className="form-section">
            <h2>✨ Customize Lease Sections</h2>
            <p className="section-description">
              Add your specific rules and requirements for each section. The AI will incorporate them into the lease agreement.
            </p>
            
            {template && Object.entries(template).map(([key, section]) => {
              if (!section.customizable) return null;
              
              return (
                <div key={key} className="custom-section">
                  <button
                    type="button"
                    className={`section-toggle ${activeSection === key ? 'active' : ''}`}
                    onClick={() => setActiveSection(activeSection === key ? '' : key)}
                  >
                    <span>{section.title}</span>
                    <span className="toggle-icon">{activeSection === key ? '−' : '+'}</span>
                  </button>
                  
                  {activeSection === key && (
                    <div className="section-content">
                      <div className="baseline-preview">
                        <strong>Baseline Template:</strong>
                        <p>{section.baseline}</p>
                      </div>
                      <div className="custom-input">
                        <label>Your Custom Requirements:</label>
                        <textarea
                          value={config.customSections?.[key] || ''}
                          onChange={(e) => handleCustomSectionChange(key, e.target.value)}
                          onBlur={(e) => validateCustomSection(key, e.target.value)}
                          placeholder="Describe any specific rules, requirements, or changes you want for this section..."
                          rows={4}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </section>

          {/* Generate Button */}
          <div className="form-actions">
            <button
              type="button"
              className="btn-generate"
              onClick={generateLease}
              disabled={generating || !config.propertyAddress || !config.landlordName || !config.tenantName || !config.startDate || !config.rentAmount || !config.securityDeposit}
              data-voice-id="generate-lease-btn"
            >
              {generating ? 'Generating Lease...' : '🚀 Generate Lease Agreement'}
            </button>
          </div>
        </div>
      ) : (
        <div className="lease-preview">
          <div className="preview-header">
            <h2>📄 Generated Lease Agreement</h2>
            <div className="preview-actions">
              <button onClick={() => setGeneratedLease(null)} className="btn-secondary" data-voice-id="edit-lease-btn">
                ← Edit Details
              </button>
              <button onClick={copyToClipboard} className="btn-secondary" data-voice-id="copy-lease-btn">
                📋 Copy to Clipboard
              </button>
              <button onClick={exportToText} className="btn-primary" data-voice-id="download-lease-btn">
                💾 Download .txt
              </button>
            </div>
          </div>

          {summary && (
            <div className="lease-summary">
              <h3>📌 Quick Summary</h3>
              <div className="summary-content">{summary}</div>
            </div>
          )}

          <div className="lease-document">
            <div className="document-header">
              <h1>RESIDENTIAL LEASE AGREEMENT</h1>
              <p className="generated-date">Generated: {new Date().toLocaleDateString()}</p>
            </div>

            {Object.entries(generatedLease.sections).map(([key, section]) => (
              <div key={key} className="document-section">
                <h2>{section.title}</h2>
                <p className="section-content">{section.content}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default LeaseBuilder;
