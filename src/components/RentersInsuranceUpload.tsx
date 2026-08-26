import React, { useState, useRef, useEffect } from 'react';
import { RentersInsurancePolicy } from '../types/insurance';
import { uploadInsuranceDocument } from '../services/storageService';

interface RentersInsuranceUploadProps {
  tenantId: string;
  propertyId: string;
  ownerId: string;
  existingInsurance?: RentersInsurancePolicy | null;
  onUploadComplete?: (policy: RentersInsurancePolicy) => void;
}

interface InsuranceDocument {
  id: string;
  policy: RentersInsurancePolicy;
  fileUrl?: string;
  uploadedAt: string;
  status: 'active' | 'expired' | 'pending_review';
}

const RentersInsuranceUpload: React.FC<RentersInsuranceUploadProps> = ({
  tenantId,
  propertyId,
  ownerId,
  existingInsurance,
  onUploadComplete
}) => {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [parsing, setParsing] = useState(false);
  const [parsedPolicy, setParsedPolicy] = useState<RentersInsurancePolicy | null>(existingInsurance || null);
  const [existingDocuments, setExistingDocuments] = useState<InsuranceDocument[]>([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing insurance documents
  useEffect(() => {
    const loadExistingInsurance = async () => {
      if (!tenantId || !propertyId) return;
      
      try {
        const response = await fetch(`/api/insurance/tenant/${tenantId}?propertyId=${propertyId}`);
        const data = await response.json();
        
        if (data.ok && data.insuranceDocuments) {
          setExistingDocuments(data.insuranceDocuments);
          // Set the latest active policy as parsed policy
          const activePolicy = data.insuranceDocuments.find((doc: InsuranceDocument) => doc.status === 'active');
          if (activePolicy?.policy) {
            setParsedPolicy(activePolicy.policy);
          }
        }
      } catch (err) {
        console.error('[InsuranceUpload] Error loading existing insurance:', err);
      } finally {
        setLoadingExisting(false);
      }
    };

    loadExistingInsurance();
  }, [tenantId, propertyId]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
      setError('Please upload a PDF, JPG, PNG, or WebP file');
      return;
    }

    // Validate file size (5MB max)
    if (file.size > 5 * 1024 * 1024) {
      setError('File size must be less than 5MB');
      return;
    }

    setError(null);
    setSuccess(null);
    setUploading(true);
    setUploadProgress(10);

    try {
      // First, read file for AI parsing (needs base64 for vision API)
      const reader = new FileReader();
      
      reader.onprogress = (event) => {
        if (event.lengthComputable) {
          const progress = (event.loaded / event.total) * 20;
          setUploadProgress(10 + progress);
        }
      };

      reader.onload = async () => {
        setUploadProgress(35);
        setParsing(true);

        const base64Data = reader.result as string;

        try {
          // Step 1: Parse the insurance document using AI (needs base64)
          const parseResponse = await fetch('/api/lease/parse-insurance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageData: base64Data })
          });

          const parseData = await parseResponse.json();
          setUploadProgress(55);

          if (!parseData.ok || !parseData.policy) {
            throw new Error(parseData.error || 'Failed to parse insurance document');
          }

          const policy = parseData.policy as RentersInsurancePolicy;
          setParsedPolicy(policy);
          setUploadProgress(65);

          // Step 2: Upload file to Firebase Storage (not base64 to Firestore!)
          const uploadResult = await uploadInsuranceDocument(ownerId, propertyId, tenantId, file);
          setUploadProgress(85);

          if (!uploadResult.success) {
            throw new Error(uploadResult.error || 'Failed to upload file to storage');
          }

          // Step 3: Save metadata to backend (just the URL, not the file data)
          const saveResponse = await fetch('/api/insurance/save-metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tenantId,
              propertyId,
              ownerId,
              fileName: file.name,
              fileType: file.type,
              fileSize: file.size,
              fileUrl: uploadResult.downloadURL,  // Storage URL instead of base64
              storagePath: uploadResult.storagePath,
              policy: policy
            })
          });

          const saveData = await saveResponse.json();
          setUploadProgress(100);

          if (!saveData.ok) {
            throw new Error(saveData.error || 'Failed to save insurance record');
          }

          setSuccess('Insurance document uploaded successfully! Your landlord has been notified.');
          
          // Add to existing documents list
          setExistingDocuments(prev => [saveData.insuranceDocument, ...prev]);
          
          // Notify parent component
          if (onUploadComplete) {
            onUploadComplete(policy);
          }

        } catch (parseError: any) {
          console.error('[InsuranceUpload] Parse/Upload error:', parseError);
          setError(parseError.message || 'Failed to process insurance document');
        } finally {
          setParsing(false);
          setUploading(false);
        }
      };

      reader.onerror = () => {
        setError('Failed to read file');
        setUploading(false);
      };

      reader.readAsDataURL(file);

    } catch (err: any) {
      console.error('[InsuranceUpload] Error:', err);
      setError(err.message || 'Failed to upload insurance document');
      setUploading(false);
    }
  };

  const isExpired = (expirationDate: string) => {
    return new Date(expirationDate) < new Date();
  };

  const getDaysUntilExpiration = (expirationDate: string) => {
    const expDate = new Date(expirationDate);
    const today = new Date();
    const diffTime = expDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  const formatCurrency = (amount: number | undefined) => {
    if (!amount) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0
    }).format(amount);
  };

  return (
    <div className="bg-white rounded-xl shadow-md p-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-12 h-12 bg-teal-100 rounded-full flex items-center justify-center">
          <svg className="w-6 h-6 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
        </div>
        <div>
          <h3 className="text-xl font-bold text-gray-900">Renter's Insurance</h3>
          <p className="text-sm text-gray-500">Upload your Certificate of Insurance (COI)</p>
        </div>
      </div>

      {/* Loading existing insurance */}
      {loadingExisting && (
        <div className="flex items-center justify-center py-8 mb-4">
          <svg className="animate-spin h-6 w-6 text-teal-600 mr-2" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-gray-500">Loading insurance info...</span>
        </div>
      )}

      {/* Error/Success Messages */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {success && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg flex items-start gap-3">
          <svg className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          <p className="text-sm text-green-700">{success}</p>
        </div>
      )}

      {/* Current Policy Display */}
      {parsedPolicy && (
        <div className={`mb-6 p-4 rounded-lg border ${
          isExpired(parsedPolicy.expirationDate)
            ? 'bg-red-50 border-red-200'
            : getDaysUntilExpiration(parsedPolicy.expirationDate) <= 30
            ? 'bg-amber-50 border-amber-200'
            : 'bg-green-50 border-green-200'
        }`}>
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-center gap-2">
              {isExpired(parsedPolicy.expirationDate) ? (
                <>
                  <span className="text-xl">⚠️</span>
                  <span className="font-semibold text-red-700">Policy Expired</span>
                </>
              ) : (
                <>
                  <span className="text-xl">✅</span>
                  <span className="font-semibold text-green-700">Active Policy</span>
                </>
              )}
            </div>
            {!isExpired(parsedPolicy.expirationDate) && getDaysUntilExpiration(parsedPolicy.expirationDate) <= 30 && (
              <span className="text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full">
                Expires in {getDaysUntilExpiration(parsedPolicy.expirationDate)} days
              </span>
            )}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Insurance Company</p>
              <p className="font-medium text-gray-900">{parsedPolicy.insuranceCompany}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Policy Number</p>
              <p className="font-medium text-gray-900">{parsedPolicy.policyNumber}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Policy Holder</p>
              <p className="font-medium text-gray-900">{parsedPolicy.policyHolder}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide">Expiration Date</p>
              <p className={`font-medium ${isExpired(parsedPolicy.expirationDate) ? 'text-red-600' : 'text-gray-900'}`}>
                {new Date(parsedPolicy.expirationDate).toLocaleDateString()}
              </p>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-200">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">Coverage Amounts</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-white/60 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500">Liability</p>
                <p className="font-bold text-gray-900">{formatCurrency(parsedPolicy.coverageAmount?.liability)}</p>
              </div>
              <div className="bg-white/60 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500">Personal Property</p>
                <p className="font-bold text-gray-900">{formatCurrency(parsedPolicy.coverageAmount?.personalProperty)}</p>
              </div>
              <div className="bg-white/60 rounded-lg p-3 text-center">
                <p className="text-xs text-gray-500">Medical</p>
                <p className="font-bold text-gray-900">{formatCurrency(parsedPolicy.coverageAmount?.medicalPayments)}</p>
              </div>
            </div>
          </div>

          {parsedPolicy.landlordListedAsInterested && (
            <div className="mt-3 flex items-center gap-2 text-sm text-green-700">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>Landlord listed as interested party</span>
            </div>
          )}
        </div>
      )}

      {/* Upload Area */}
      <div
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={`border-2 border-dashed rounded-lg p-8 text-center transition-all cursor-pointer ${
          uploading
            ? 'border-gray-300 bg-gray-50 cursor-not-allowed'
            : 'border-teal-300 hover:border-teal-500 hover:bg-teal-50'
        }`}
      >
        {uploading ? (
          <div className="space-y-4">
            <div className="animate-spin w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full mx-auto"></div>
            <p className="text-gray-600">
              {parsing ? 'Analyzing insurance document...' : 'Uploading...'}
            </p>
            <div className="w-full bg-gray-200 rounded-full h-2.5 max-w-xs mx-auto">
              <div
                className="bg-teal-600 h-2.5 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress}%` }}
              ></div>
            </div>
          </div>
        ) : (
          <>
            <svg className="w-12 h-12 text-teal-400 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="font-medium text-gray-900 mb-1">
              {parsedPolicy ? 'Upload Updated Insurance' : 'Upload Certificate of Insurance'}
            </p>
            <p className="text-sm text-gray-500">
              Click to upload or drag and drop
            </p>
            <p className="text-xs text-gray-400 mt-2">
              PDF, JPG, PNG, WebP up to 5MB
            </p>
          </>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf"
          onChange={handleFileSelect}
          disabled={uploading}
          className="hidden"
        />
      </div>

      {/* Requirements Info */}
      <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
        <div className="flex items-start gap-3">
          <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
          <div className="text-sm text-blue-900">
            <p className="font-medium mb-1">Insurance Requirements</p>
            <ul className="list-disc list-inside space-y-1 text-blue-800">
              <li>Minimum liability coverage: $100,000</li>
              <li>Minimum personal property: $25,000</li>
              <li>Landlord must be listed as interested party</li>
              <li>Policy must be active and not expired</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Previous Uploads */}
      {existingDocuments.length > 1 && (
        <div className="mt-6">
          <h4 className="text-sm font-medium text-gray-700 mb-3">Previous Uploads</h4>
          <div className="space-y-2">
            {existingDocuments.slice(1).map((doc, index) => (
              <div
                key={doc.id || index}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">📄</span>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{doc.policy?.insuranceCompany}</p>
                    <p className="text-xs text-gray-500">
                      Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <span className={`text-xs px-2 py-1 rounded-full ${
                  doc.status === 'active'
                    ? 'bg-green-100 text-green-700'
                    : doc.status === 'expired'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-gray-100 text-gray-700'
                }`}>
                  {doc.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default RentersInsuranceUpload;
