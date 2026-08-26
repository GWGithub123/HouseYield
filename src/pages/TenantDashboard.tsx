import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import TenantPaymentForm from '../components/TenantPaymentForm';
import MaintenanceRequestForm from '../components/MaintenanceRequestForm';
import TenantUpcomingVisits from '../components/TenantUpcomingVisits';
import ProfilePhotoUpload from '../components/ProfilePhotoUpload';
import RentersInsuranceUpload from '../components/RentersInsuranceUpload';
import SigningReceipt from '../components/SigningReceipt';

// Signature interface
interface Signature {
  name: string;
  role: string;
  email: string;
  status: string;
  signedAt: string | null;
  signatureImage: string | null;
  ipAddress: string | null;
}

// Document interface for tenant documents
interface TenantDocument {
  id: string;
  title: string;
  documentType: string;
  status: string;
  content?: string;
  contentWithSignatures?: string;
  requiresSignature: boolean;
  createdAt: string;
  completedAt?: string;
  metadata?: {
    icon?: string;
    description?: string;
    isUploaded?: boolean;
    fileName?: string;
    filePath?: string;
    pdfPath?: string;
  };
  signatureRequests?: Array<{
    signerId: string;
    signerFirebaseUid?: string;
    signerName?: string;
    signerRole: string;
    status: string;
    token?: string;
    signedAt?: string;
    signature?: string;
  }>;
}

interface TenantMessageThreadItem {
  id: string;
  subject?: string;
  message: string;
  senderType?: 'tenant' | 'assistant' | string;
  direction?: 'outbound' | 'inbound' | string;
  createdAt?: string;
}

export default function TenantDashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, logout } = useAuth();
  const hasPaymentRedirect = searchParams.get('payment') || searchParams.get('autopay');
  const [activeSection, setActiveSection] = useState<'overview' | 'payment' | 'maintenance' | 'contact' | 'documents' | 'insurance'>(
    hasPaymentRedirect ? 'payment' : 'overview'
  );
  const [message, setMessage] = useState('');
  const [messageSending, setMessageSending] = useState(false);
  const [messageSuccess, setMessageSuccess] = useState(false);
  const [autoReplyNotice, setAutoReplyNotice] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversation, setConversation] = useState<TenantMessageThreadItem[]>([]);
  const [paymentStatus, setPaymentStatus] = useState<'success' | 'cancelled' | null>(null);
  const [landlordStripeAccountId, setLandlordStripeAccountId] = useState<string | null>(null);
  const [accountCheckMessage, setAccountCheckMessage] = useState<string>('');
  const [profilePhotoURL, setProfilePhotoURL] = useState<string | undefined>(user?.photoURL);
  const [tenantMonthlyRent, setTenantMonthlyRent] = useState<number | undefined>(undefined);
  
  // Property details state (fetched from Firestore tenant data)
  const [propertyDetails, setPropertyDetails] = useState<{
    address: string;
    unit: string;
    ownerId?: string;
    propertyId?: string;
  } | null>(null);
  
  // Document state
  const [documents, setDocuments] = useState<TenantDocument[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [pendingSignatureCount, setPendingSignatureCount] = useState(0);
  const [documentTab, setDocumentTab] = useState<'pending' | 'signed'>('pending');
  const [viewingDocument, setViewingDocument] = useState<TenantDocument | null>(null);
  const [viewingSignatures, setViewingSignatures] = useState<Signature[]>([]);
  const [loadingSignedDoc, setLoadingSignedDoc] = useState(false);
  const [tenantFileViewerFullscreen, setTenantFileViewerFullscreen] = useState(false);
  const [showTenantReceipt, setShowTenantReceipt] = useState(false);
  const [tenantReceiptDocId, setTenantReceiptDocId] = useState<string | null>(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [paymentHistory, setPaymentHistory] = useState<any[]>([]);
  const [paymentHistoryLoading, setPaymentHistoryLoading] = useState(false);
  const [maintenanceVisitsRefreshKey, setMaintenanceVisitsRefreshKey] = useState(0);

  // Fetch tenant's property details from Firestore
  useEffect(() => {
    const fetchTenantDetails = async () => {
      if (!user?.id) return;
      
      try {
        // Fetch tenant data from Firestore to get property details
        const response = await fetch(`/api/tenants/${user.id}`);
        const data = await response.json();
        
        if (data.ok && data.tenant) {
          console.log('[TenantDashboard] Loaded tenant details:', data.tenant);
          console.log('[TenantDashboard] Tenant photoURL from DB:', data.tenant.photoURL);
          console.log('[TenantDashboard] User photoURL from auth:', user.photoURL);
          
          setPropertyDetails({
            address: data.tenant.propertyAddress || '',
            unit: data.tenant.unit || '',
            ownerId: data.tenant.ownerId || data.tenant.landlordId || '',
            propertyId: data.tenant.propertyId || ''
          });

          if (data.tenant.monthlyRent) {
            setTenantMonthlyRent(parseFloat(data.tenant.monthlyRent));
          }
          
          // Load profile photo from tenant record if available
          if (data.tenant.photoURL) {
            console.log('[TenantDashboard] Using photoURL from tenant record');
            setProfilePhotoURL(data.tenant.photoURL);
          } else if (user.photoURL) {
            // Sync Google photo to tenant record if tenant doesn't have one yet
            console.log('[TenantDashboard] Syncing Google photo to tenant record:', user.photoURL);
            try {
              const syncResponse = await fetch(`/api/tenants/${user.id}/photo`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ photoURL: user.photoURL })
              });
              const syncData = await syncResponse.json();
              console.log('[TenantDashboard] Photo sync result:', syncData);
              
              if (syncData.ok) {
                setProfilePhotoURL(user.photoURL);
              }
            } catch (syncError) {
              console.error('[TenantDashboard] Failed to sync photo:', syncError);
            }
          } else {
            console.log('[TenantDashboard] No photoURL available from tenant record or user auth');
          }
        }
      } catch (error) {
        console.error('[TenantDashboard] Error fetching tenant details:', error);
      }
    };
    
    fetchTenantDetails();
  }, [user?.id, user?.photoURL]);

  // Fetch landlord's Stripe account — runs after tenant details load so we have ownerId
  useEffect(() => {
    const fetchLandlordAccount = async () => {
      try {
        const ownerId = propertyDetails?.ownerId || (user as any)?.landlordId || (user as any)?.ownerId;

        // Build list of IDs to try: real ownerId first, then legacy fallbacks
        const candidates: string[] = [];
        if (ownerId) candidates.push(ownerId);
        // Legacy hardcoded fallbacks (only used if no ownerId found)
        if (!ownerId) candidates.push('owner2', 'landlord-1');

        let foundAccount = null;

        for (const landlordUserId of candidates) {
          try {
            const response = await fetch(`/api/stripe-connect/accounts/${landlordUserId}`);
            const data = await response.json();
            if (data.ok && data.accounts && data.accounts.length > 0) {
              const activeAccount = data.accounts.find((acc: any) =>
                acc.chargesEnabled && acc.payoutsEnabled
              ) || data.accounts[0];
              if (activeAccount) {
                foundAccount = activeAccount;
                console.log('[Tenant] ✅ Found Stripe account for', landlordUserId, ':', activeAccount.accountId);
                break;
              }
            }
          } catch (_e) { /* try next */ }
        }

        if (foundAccount) {
          setLandlordStripeAccountId(foundAccount.accountId);
        } else {
          console.log('[Tenant] ❌ No active Stripe accounts found for ownerId:', ownerId);
          setLandlordStripeAccountId(null);
        }
        setAccountCheckMessage('');
      } catch (error) {
        console.error('[Tenant] Error fetching landlord account:', error);
        setAccountCheckMessage('');
        setLandlordStripeAccountId(null);
      }
    };

    // Run once on mount, then re-run if propertyDetails loads after
    fetchLandlordAccount();
  }, [propertyDetails?.ownerId]);

  // Check for payment status in URL params
  useEffect(() => {
    const payment = searchParams.get('payment');
    const autopay = searchParams.get('autopay');
    const sessionId = searchParams.get('session_id');

    if (autopay === 'success' || autopay === 'cancelled') {
      setActiveSection('payment');
      return;
    }
    
    if (payment === 'success') {
      setPaymentStatus('success');
      setActiveSection('payment');

      // Confirm the payment server-side (records to Firestore without needing webhooks)
      if (sessionId) {
        fetch('/api/stripe-connect/confirm-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        })
          .then(r => r.json())
          .then(data => {
            console.log('[TenantDashboard] Confirmed session:', data);
            // Load payment history immediately after confirming
            loadPaymentHistory();
          })
          .catch(err => console.error('[TenantDashboard] Failed to confirm session:', err));
      } else {
        // No session_id — just try loading after a delay
        setTimeout(() => loadPaymentHistory(), 2000);
      }

      // Clear URL params after 5 seconds
      setTimeout(() => {
        setPaymentStatus(null);
        setSearchParams({});
      }, 5000);
    } else if (payment === 'cancelled') {
      setPaymentStatus('cancelled');
      setActiveSection('payment');
      // Clear URL params after 5 seconds
      setTimeout(() => {
        setPaymentStatus(null);
        setSearchParams({});
      }, 5000);
    }
  }, [searchParams, setSearchParams]);

  if (!user || user.role !== 'tenant') {
    navigate('/login/tenant');
    return null;
  }

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessageSending(true);
    setMessageSuccess(false);

    try {
      const response = await fetch('/api/tenant-messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: user.id,
          tenantEmail: user.email,
          tenantName: user.name,
          ownerId: propertyDetails?.ownerId || user.landlordId,
          propertyId: propertyDetails?.propertyId,
          propertyAddress: user.propertyAddress || propertyDetails?.address,
          unit: user.unit || propertyDetails?.unit,
          message,
          subject: 'General Message'
        })
      });

      const data = await response.json();

      if (!data.ok) {
        throw new Error(data.error || 'Failed to send message');
      }

      setMessageSuccess(true);
      setAutoReplyNotice(Boolean(data.autoReplyScheduled));
      setMessage('');

      await loadTenantConversation();
    } catch (err) {
      console.error('Failed to send message:', err);
      alert('Failed to send message. Please try again.');
    } finally {
      setMessageSending(false);
    }
  };

  const loadTenantConversation = async () => {
    if (!user?.id) return;
    setConversationLoading(true);
    try {
      const response = await fetch(`/api/tenant/${encodeURIComponent(user.id)}/activity`);
      const data = await response.json();
      if (data.ok && data.activity?.messages) {
        const sorted = [...data.activity.messages].sort(
          (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
        );
        setConversation(sorted);
      }
    } catch (error) {
      console.error('[TenantDashboard] Failed to load conversation:', error);
    } finally {
      setConversationLoading(false);
    }
  };

  const loadPaymentHistory = async () => {
    if (!user?.email) return;
    setPaymentHistoryLoading(true);
    try {
      // Query Stripe directly — most reliable, no webhook dependency
      const params = new URLSearchParams({ tenantEmail: user.email });
      if (landlordStripeAccountId) params.set('accountId', landlordStripeAccountId);
      const response = await fetch(`/api/stripe-connect/tenant-payment-history?${params}`);
      const data = await response.json();
      if (data.ok && data.payments?.length > 0) {
        setPaymentHistory(data.payments);
        return;
      }
      // Fallback: Firestore activity log
      const fallback = await fetch(`/api/tenant/${encodeURIComponent(user.id)}/activity`);
      const fallbackData = await fallback.json();
      if (fallbackData.ok && fallbackData.activity?.payments) {
        const sorted = [...fallbackData.activity.payments].sort(
          (a, b) => new Date(b.paymentDate || b.createdAt || 0).getTime() - new Date(a.paymentDate || a.createdAt || 0).getTime()
        );
        setPaymentHistory(sorted);
      }
    } catch (error) {
      console.error('[TenantDashboard] Failed to load payment history:', error);
    } finally {
      setPaymentHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (activeSection === 'payment' && user?.id) {
      loadPaymentHistory();
    }
  }, [activeSection, user?.id]);

  useEffect(() => {
    if (activeSection !== 'contact' || !user?.id) return;

    loadTenantConversation();

    const interval = setInterval(() => {
      loadTenantConversation();
    }, 30000);

    return () => clearInterval(interval);
  }, [activeSection, user?.id]);

  // Load documents for tenant
  useEffect(() => {
    const loadDocuments = async () => {
      if (!user?.id) return;
      
      setDocumentsLoading(true);
      try {
        // Build query params - filter by tenantId AND propertyId for security
        const params = new URLSearchParams();
        params.append('tenantId', user.id);
        
        // Also filter by propertyId if available (ensures tenant only sees their property's docs)
        if (user.propertyId) {
          params.append('propertyId', user.propertyId);
        }
        
        const response = await fetch(`/api/documents?${params.toString()}`);
        const data = await response.json();
        
        if (data.ok && data.documents) {
          setDocuments(data.documents);
          
          // Count pending signatures for this tenant
          const pending = data.documents.filter((doc: TenantDocument) => {
            if (!doc.requiresSignature) return false;
            if (!doc.signatureRequests) return false;
            
            // Check both signerId and signerFirebaseUid since tenant may be identified by either
            return doc.signatureRequests.some(
              req => (req.signerId === user.id || req.signerFirebaseUid === user.id) && req.status === 'pending'
            );
          });
          setPendingSignatureCount(pending.length);
        }
      } catch (error) {
        console.error('[Tenant] Failed to load documents:', error);
      } finally {
        setDocumentsLoading(false);
      }
    };

    if (user) {
      loadDocuments();
    }
  }, [user]);

  // View signed document with signatures
  const viewSignedDocument = async (doc: TenantDocument) => {
    setLoadingSignedDoc(true);
    try {
      const response = await fetch(`/api/documents/${doc.id}/signed`);
      const data = await response.json();
      
      if (data.ok) {
        setViewingDocument(data.document);
        setViewingSignatures(data.signatures || []);
      } else {
        // Fallback to basic document view
        setViewingDocument(doc);
        setViewingSignatures([]);
      }
    } catch (error) {
      console.error('[Tenant] Failed to load signed document:', error);
      setViewingDocument(doc);
      setViewingSignatures([]);
    } finally {
      setLoadingSignedDoc(false);
    }
  };

  const closeDocumentViewer = () => {
    setViewingDocument(null);
    setViewingSignatures([]);
    setTenantFileViewerFullscreen(false);
  };

  const getDocumentViewerUrl = (doc: TenantDocument) => {
    if (doc.metadata?.isUploaded && doc.metadata?.filePath) {
      return doc.metadata.filePath;
    }

    return doc.metadata?.pdfPath || `/api/documents/${doc.id}/pdf`;
  };

  const handleTenantDocumentDownload = (doc: TenantDocument) => {
    const link = document.createElement('a');
    link.href = getDocumentViewerUrl(doc);
    link.download = doc.metadata?.fileName || `${doc.title.replace(/[^a-z0-9]/gi, '_')}.pdf`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Filter documents by tab
  const pendingDocs = documents.filter(doc => {
    if (!doc.signatureRequests) return false;
    return doc.signatureRequests.some(
      req => (req.signerId === user?.id || req.signerFirebaseUid === user?.id) && req.status === 'pending'
    );
  });

  const signedDocs = documents.filter(doc => {
    if (!doc.signatureRequests) return false;
    const tenantSigned = doc.signatureRequests.some(
      req => (req.signerId === user?.id || req.signerFirebaseUid === user?.id) && req.status === 'signed'
    );
    return tenantSigned;
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-white to-purple-100" data-voice-id="tenant-dashboard">
      {/* Header */}
      <header className="bg-white shadow-md" data-voice-id="tenant-header">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Profile Photo */}
              {profilePhotoURL ? (
                <img
                  src={profilePhotoURL}
                  alt="Profile"
                  className="w-10 h-10 rounded-full object-cover border-2 border-purple-200"
                />
              ) : (
                <div className="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center">
                  <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
              )}
              <div>
                <h1 className="text-xl font-bold text-gray-900">Tenant Portal</h1>
                <p className="text-sm text-gray-600">{user.name}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowProfileModal(true)}
                className={`flex items-center gap-2 px-4 py-2 text-sm rounded-lg transition-colors ${
                  showProfileModal
                    ? 'bg-purple-50 text-purple-700 border border-purple-200'
                    : 'text-gray-700 hover:bg-gray-100 border border-transparent'
                }`}
                data-voice-id="tenant-profile-header-btn"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Profile
              </button>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                data-voice-id="logout-btn"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Property Info Card */}
        <div className="bg-white rounded-xl shadow-md p-6 mb-8">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Your Property</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-purple-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <div>
                <div className="text-sm text-gray-500">Address</div>
                <div className="font-medium text-gray-900">{user.propertyAddress || propertyDetails?.address || 'N/A'}</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-purple-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
              </svg>
              <div>
                <div className="text-sm text-gray-500">Unit</div>
                <div className="font-medium text-gray-900">{user.unit || propertyDetails?.unit || 'N/A'}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
          <button
            onClick={() => setActiveSection('payment')}
            data-voice-id="tenant-pay-rent-btn"
            className={`bg-white rounded-xl shadow-md p-6 text-left transition-all hover:shadow-lg ${
              activeSection === 'payment' ? 'ring-2 ring-purple-500' : ''
            }`}
          >
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Pay Rent</h3>
            <p className="text-sm text-gray-600">Make secure rent payments with ACH or card</p>
          </button>

          <button
            onClick={() => setActiveSection('maintenance')}
            data-voice-id="tenant-maintenance-btn"
            className={`bg-white rounded-xl shadow-md p-6 text-left transition-all hover:shadow-lg ${
              activeSection === 'maintenance' ? 'ring-2 ring-purple-500' : ''
            }`}
          >
            <div className="w-12 h-12 bg-orange-100 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Maintenance Request</h3>
            <p className="text-sm text-gray-600">Submit and track maintenance issues</p>
          </button>

          <button
            onClick={() => setActiveSection('contact')}
            data-voice-id="tenant-contact-owner-btn"
            className={`bg-white rounded-xl shadow-md p-6 text-left transition-all hover:shadow-lg ${
              activeSection === 'contact' ? 'ring-2 ring-purple-500' : ''
            }`}
          >
            <div className="w-12 h-12 bg-blue-100 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Contact Owner</h3>
            <p className="text-sm text-gray-600">Send messages to your property owner</p>
          </button>

          <button
            onClick={() => setActiveSection('documents')}
            data-voice-id="tenant-documents-btn"
            className={`bg-white rounded-xl shadow-md p-6 text-left transition-all hover:shadow-lg relative ${
              activeSection === 'documents' ? 'ring-2 ring-purple-500' : ''
            }`}
          >
            {pendingSignatureCount > 0 && (
              <div className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 rounded-full flex items-center justify-center">
                <span className="text-xs font-bold text-white">{pendingSignatureCount}</span>
              </div>
            )}
            <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Documents
              {pendingSignatureCount > 0 && (
                <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded-full">Action Required</span>
              )}
            </h3>
            <p className="text-sm text-gray-600">Review and sign lease documents</p>
          </button>

          <button
            onClick={() => setActiveSection('insurance')}
            data-voice-id="tenant-insurance-btn"
            className={`bg-white rounded-xl shadow-md p-6 text-left transition-all hover:shadow-lg ${
              activeSection === 'insurance' ? 'ring-2 ring-purple-500' : ''
            }`}
          >
            <div className="w-12 h-12 bg-teal-100 rounded-full flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Renter's Insurance</h3>
            <p className="text-sm text-gray-600">Upload your insurance certificate</p>
          </button>
        </div>

        {/* Main Content Area */}
        <div className="bg-white rounded-xl shadow-md p-8" data-voice-id="tenant-content-area">
          {activeSection === 'overview' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-4">Welcome to Your Tenant Portal</h2>
              <p className="text-gray-600 mb-6">
                Select one of the options above to get started. You can pay rent, submit maintenance requests, or contact your property owner.
              </p>
              <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-purple-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                  </svg>
                  <div>
                    <div className="text-sm font-medium text-purple-900">Need Help?</div>
                    <div className="text-sm text-purple-700 mt-1">
                      If you have any questions or need assistance, please use the "Contact Owner" section to reach out.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'payment' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-6">Pay Rent</h2>

              {paymentStatus === 'success' && (
                <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4">
                  <div className="flex items-start gap-3">
                    <div className="h-8 w-8 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                      <svg className="h-5 w-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-green-900">Payment Successful!</div>
                      <div className="text-sm text-green-700 mt-1">
                        Your rent payment has been processed successfully. You should receive a confirmation email shortly.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {paymentStatus === 'cancelled' && (
                <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <div className="flex items-start gap-3">
                    <div className="h-8 w-8 rounded-full bg-amber-100 flex items-center justify-center flex-shrink-0">
                      <svg className="h-5 w-5 text-amber-600" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-amber-900">Payment Cancelled</div>
                      <div className="text-sm text-amber-700 mt-1">
                        Your payment was cancelled. You can try again when you're ready.
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <TenantPaymentForm
                landlordAccountId={landlordStripeAccountId}
                tenantName={user.name}
                tenantEmail={user.email}
                tenantId={user.id}
                ownerId={propertyDetails?.ownerId || user.landlordAccountId || ''}
                propertyId={propertyDetails?.propertyId || ''}
                propertyAddress={user.propertyAddress || propertyDetails?.address || ''}
                monthlyRent={tenantMonthlyRent}
                onPaymentComplete={() => {}}
                onError={(error) => {
                  console.error('Payment error:', error);
                }}
              />

              {/* Payment History */}
              <div className="mt-8">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">Payment History</h3>
                {paymentHistoryLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <svg className="animate-spin h-6 w-6 text-blue-600" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                  </div>
                ) : paymentHistory.length === 0 ? (
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-6 text-center">
                    <svg className="h-10 w-10 text-gray-300 mx-auto mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l2-2 4 4M7 7h10M7 11h6" />
                    </svg>
                    <p className="text-sm text-gray-500">No payment history yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {paymentHistory.map((payment) => (
                      <div key={payment.id} className="rounded-lg border border-gray-200 bg-white p-4 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                            payment.status === 'completed' ? 'bg-green-100' :
                            payment.status === 'pending' ? 'bg-yellow-100' : 'bg-red-100'
                          }`}>
                            {payment.status === 'completed' ? (
                              <svg className="h-5 w-5 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                              </svg>
                            ) : payment.status === 'pending' ? (
                              <svg className="h-5 w-5 text-yellow-600" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd" />
                              </svg>
                            ) : (
                              <svg className="h-5 w-5 text-red-600" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                          <div>
                            <div className="text-sm font-medium text-gray-900">
                              {payment.description || 'Rent Payment'}{payment.propertyAddress ? ` — ${payment.propertyAddress}` : (user.propertyAddress ? ` — ${user.propertyAddress}` : '')}
                            </div>
                            <div className="text-xs text-gray-500 mt-0.5">
                              {new Date(payment.date || payment.paymentDate || payment.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                              {payment.paymentMethod && ` · ${payment.paymentMethod === 'us_bank_account' ? 'ACH Bank Transfer' : payment.paymentMethod === 'card' ? 'Credit/Debit Card' : payment.paymentMethod}`}
                              {payment.type === 'autopay' && <span className="ml-1 text-blue-500">· AutoPay</span>}
                            </div>
                            {payment.autopayCustomSchedule && (
                              <div className="text-xs mt-1 text-slate-600">
                                {payment.customScheduledFor
                                  ? `Scheduled for ${new Date(payment.customScheduledFor).toLocaleString('en-US', {
                                      year: 'numeric',
                                      month: 'long',
                                      day: 'numeric',
                                      hour: 'numeric',
                                      minute: '2-digit'
                                    })}`
                                  : 'Immediate custom renewal'}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0 ml-4 flex flex-col items-end gap-1">
                          <div className="text-base font-semibold text-gray-900">${(payment.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                          <div className={`text-xs font-medium capitalize ${
                            payment.status === 'completed' ? 'text-green-600' :
                            payment.status === 'pending' ? 'text-yellow-600' : 'text-red-600'
                          }`}>
                            {payment.status === 'completed' ? 'Settled' : payment.status === 'pending' ? 'Pending' : 'Failed'}
                          </div>
                          {payment.stripeUrl && (
                            <a href={payment.stripeUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
                              {payment.status === 'completed' ? 'Receipt' : 'Invoice'}
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeSection === 'maintenance' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-6">Maintenance</h2>
              {user?.id && (
                <TenantUpcomingVisits
                  tenantId={user.id}
                  refreshKey={maintenanceVisitsRefreshKey}
                />
              )}
              <h3 className="text-xl font-semibold text-gray-900 mb-4">Submit Maintenance Request</h3>
              <MaintenanceRequestForm
                propertyAddress={user.propertyAddress || propertyDetails?.address}
                unit={user.unit || propertyDetails?.unit}
                tenantId={user.id}
                tenantEmail={user.email}
                tenantName={user.name}
                ownerId={propertyDetails?.ownerId || user.landlordId}
                propertyId={propertyDetails?.propertyId}
                onSubmitSuccess={() => {
                  setMaintenanceVisitsRefreshKey((key) => key + 1);
                }}
              />
            </div>
          )}

          {activeSection === 'contact' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-6">Contact Owner</h2>

              {messageSuccess && (
                <div className="mb-6 bg-green-50 border border-green-200 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <div>
                      <div className="text-sm font-medium text-green-800">Message Sent</div>
                      <div className="text-sm text-green-700 mt-1">Your property owner will respond soon.</div>
                    </div>
                  </div>
                </div>
              )}

              {autoReplyNotice && (
                <div className="mb-6 bg-indigo-50 border border-indigo-200 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <svg className="w-5 h-5 text-indigo-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div>
                      <div className="text-sm font-medium text-indigo-800">Support assistant is preparing a response</div>
                      <div className="text-sm text-indigo-700 mt-1">General questions are usually answered in a few minutes in this thread.</div>
                    </div>
                  </div>
                </div>
              )}

              <form onSubmit={handleSendMessage} className="space-y-6">
                <div>
                  <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-2">
                    Your Message
                  </label>
                  <textarea
                    id="message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    required
                    rows={8}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
                    placeholder="Type your message here..."
                  />
                </div>

                <button
                  type="submit"
                  disabled={messageSending}
                  className="w-full bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200"
                >
                  {messageSending ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      Sending...
                    </span>
                  ) : (
                    'Send Message'
                  )}
                </button>
              </form>

              <div className="mt-8 pt-6 border-t border-gray-200">
                <h3 className="text-sm font-medium text-gray-900 mb-4">Contact Information</h3>
                <div className="space-y-3 text-sm text-gray-600">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    <span>Email: support@renaissancerealty.com</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                    </svg>
                    <span>Phone: (555) 123-4567</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'insurance' && user && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-6">Renter's Insurance</h2>
              <RentersInsuranceUpload
                tenantId={user.id}
                propertyId={propertyDetails?.propertyId || user.propertyId || ''}
                ownerId={propertyDetails?.ownerId || user.landlordAccountId || ''}
                onUploadComplete={(policy) => {
                  console.log('[TenantDashboard] Insurance uploaded:', policy);
                }}
              />
            </div>
          )}

          {activeSection === 'documents' && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-6">Your Documents</h2>
              
              {documentsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <svg className="animate-spin h-8 w-8 text-purple-600" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </div>
              ) : documents.length === 0 ? (
                <div className="text-center py-12">
                  <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <p className="text-gray-500 text-lg">No documents yet</p>
                  <p className="text-gray-400 text-sm mt-1">Documents from your landlord will appear here</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Document Tabs */}
                  <div className="flex border-b border-gray-200 mb-6">
                    <button
                      onClick={() => setDocumentTab('pending')}
                      className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                        documentTab === 'pending'
                          ? 'border-purple-600 text-purple-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Pending Signatures
                        {pendingSignatureCount > 0 && (
                          <span className="bg-amber-500 text-white text-xs px-2 py-0.5 rounded-full">
                            {pendingSignatureCount}
                          </span>
                        )}
                      </span>
                    </button>
                    <button
                      onClick={() => setDocumentTab('signed')}
                      className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                        documentTab === 'signed'
                          ? 'border-purple-600 text-purple-600'
                          : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        Signed Documents
                        {signedDocs.length > 0 && (
                          <span className="bg-green-500 text-white text-xs px-2 py-0.5 rounded-full">
                            {signedDocs.length}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>

                  {/* Pending Tab Content */}
                  {documentTab === 'pending' && (
                    <>
                      {pendingDocs.length === 0 ? (
                        <div className="text-center py-12 bg-gray-50 rounded-lg">
                          <svg className="w-12 h-12 text-green-400 mx-auto mb-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                          <p className="text-gray-600 font-medium">All caught up!</p>
                          <p className="text-gray-400 text-sm mt-1">No documents waiting for your signature</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {pendingDocs.map(doc => {
                            const pendingSignature = doc.signatureRequests?.find(
                              req => (req.signerId === user?.id || req.signerFirebaseUid === user?.id) && req.status === 'pending'
                            );
                            return (
                              <div key={doc.id} className="border border-amber-300 bg-amber-50 rounded-lg p-4">
                                <div className="flex items-start justify-between">
                                  <div className="flex items-start gap-4">
                                    <div className="text-3xl">{doc.metadata?.icon || '📄'}</div>
                                    <div>
                                      <h3 className="font-semibold text-gray-900">{doc.title}</h3>
                                      <p className="text-sm text-gray-500 mt-0.5">{doc.metadata?.description}</p>
                                      <div className="flex items-center gap-3 mt-2">
                                        <span className="text-xs text-gray-400">
                                          {new Date(doc.createdAt).toLocaleDateString()}
                                        </span>
                                        <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                          </svg>
                                          Awaiting Your Signature
                                        </span>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {pendingSignature?.token && (
                                      <button
                                        onClick={() => navigate(`/documents/sign/${doc.id}?token=${pendingSignature.token}`)}
                                        className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                                      >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                        </svg>
                                        Sign Now
                                      </button>
                                    )}
                                    <button
                                      onClick={() => viewSignedDocument(doc)}
                                      className="text-gray-600 hover:text-gray-900 p-2 rounded-lg hover:bg-gray-100 transition-colors"
                                      title="View Document"
                                    >
                                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}

                  {/* Signed Tab Content */}
                  {documentTab === 'signed' && (
                    <>
                      {signedDocs.length === 0 ? (
                        <div className="text-center py-12 bg-gray-50 rounded-lg">
                          <svg className="w-12 h-12 text-gray-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          <p className="text-gray-600 font-medium">No signed documents yet</p>
                          <p className="text-gray-400 text-sm mt-1">Documents you sign will appear here</p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {signedDocs.map(doc => {
                            const tenantSignature = doc.signatureRequests?.find(
                              req => (req.signerId === user?.id || req.signerFirebaseUid === user?.id) && req.status === 'signed'
                            );
                            return (
                              <div key={doc.id} className="border border-gray-200 bg-white rounded-lg p-4 hover:shadow-md transition-shadow">
                                <div className="flex items-start justify-between">
                                  <div className="flex items-start gap-4">
                                    <div className="text-3xl">{doc.metadata?.icon || '📄'}</div>
                                    <div>
                                      <h3 className="font-semibold text-gray-900">{doc.title}</h3>
                                      <p className="text-sm text-gray-500 mt-0.5">{doc.metadata?.description}</p>
                                      <div className="flex items-center gap-3 mt-2">
                                        <span className="text-xs text-gray-400">
                                          Created: {new Date(doc.createdAt).toLocaleDateString()}
                                        </span>
                                        {tenantSignature?.signedAt && (
                                          <span className="text-xs text-gray-400">
                                            Signed: {new Date(tenantSignature.signedAt).toLocaleDateString()}
                                          </span>
                                        )}
                                        {doc.status === 'completed' ? (
                                          <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                            </svg>
                                            Fully Executed
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full">
                                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                            </svg>
                                            You Signed - Awaiting Others
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  <button
                                    onClick={() => viewSignedDocument(doc)}
                                    className="bg-gray-100 hover:bg-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                                  >
                                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                    </svg>
                                    View Document
                                  </button>
                                  <button
                                    onClick={() => {
                                      setTenantReceiptDocId(doc.id);
                                      setShowTenantReceipt(true);
                                    }}
                                    className="bg-blue-50 hover:bg-blue-100 text-blue-700 px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1"
                                    title="View Signing Receipt"
                                  >
                                    📜 Receipt
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Document Viewer Modal */}
          {viewingDocument && (
            <div
              className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
              style={{ padding: tenantFileViewerFullscreen ? '0' : '16px' }}
            >
              <div
                className="bg-white shadow-2xl flex flex-col overflow-hidden"
                style={{
                  width: tenantFileViewerFullscreen ? '100%' : '100%',
                  maxWidth: tenantFileViewerFullscreen ? 'none' : '95vw',
                  height: tenantFileViewerFullscreen ? '100vh' : '92vh',
                  borderRadius: tenantFileViewerFullscreen ? '0' : '28px',
                  border: tenantFileViewerFullscreen ? 'none' : '1px solid rgb(226 232 240)'
                }}
              >
                <div className={`flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50/80 ${tenantFileViewerFullscreen ? 'px-4 py-2.5' : 'px-6 py-5'}`}>
                  <div className="flex items-center gap-4 min-w-0 flex-1">
                    <div className={`${tenantFileViewerFullscreen ? 'hidden' : 'flex'} w-10 h-10 rounded-xl border border-indigo-200 bg-indigo-50 items-center justify-center text-indigo-500 shrink-0`}>
                      <span className="text-xl">{viewingDocument.metadata?.icon || '📄'}</span>
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-[18px] text-slate-900 truncate">{viewingDocument.title}</h3>
                      <p className="text-sm text-slate-500">
                        Created {new Date(viewingDocument.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    {tenantFileViewerFullscreen && viewingSignatures.length > 0 && (
                      <div className="flex items-center gap-2 min-w-0 overflow-x-auto shrink">
                        {viewingSignatures.map((sig, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => {
                              setTenantReceiptDocId(viewingDocument.id);
                              setShowTenantReceipt(true);
                            }}
                            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap transition-colors hover:shadow-sm ${
                              sig.status === 'signed'
                                ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
                            }`}
                            title="Open signing receipt"
                          >
                            <span className={`w-2 h-2 rounded-full ${sig.status === 'signed' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                            <span className="font-semibold text-slate-900">{sig.name}</span>
                            <span className="text-slate-500">· {sig.role}</span>
                            <span className="italic">{sig.status === 'signed' && sig.signedAt ? `Signed ${new Date(sig.signedAt).toLocaleDateString()}` : 'Awaiting'}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <button
                      onClick={() => setTenantFileViewerFullscreen(!tenantFileViewerFullscreen)}
                      className={`inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors ${tenantFileViewerFullscreen ? 'w-10 h-10' : 'w-11 h-11'}`}
                      title="Open full screen viewer"
                    >
                      <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="6 1 1 1 1 6" />
                        <polyline points="10 1 15 1 15 6" />
                        <polyline points="6 15 1 15 1 10" />
                        <polyline points="10 15 15 15 15 10" />
                      </svg>
                    </button>
                    <span className={`px-4 py-1.5 rounded-full text-sm font-semibold ${
                      viewingDocument.status === 'completed'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-amber-100 text-amber-700'
                    }`}>
                      {viewingDocument.status === 'completed' ? 'Completed' : 'In Progress'}
                    </span>
                    <button
                      onClick={closeDocumentViewer}
                      className="text-slate-400 hover:text-slate-600 p-2 rounded-lg hover:bg-white"
                    >
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {!tenantFileViewerFullscreen && viewingSignatures.length > 0 && (
                  <div className="px-6 py-3 border-b border-slate-200 bg-white flex items-center gap-4 overflow-x-auto">
                    <span className="text-xs font-semibold tracking-[0.24em] uppercase text-slate-400 shrink-0">Signatures</span>
                    <div className="flex items-center gap-2 min-w-0">
                      {viewingSignatures.map((sig, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => {
                            setTenantReceiptDocId(viewingDocument.id);
                            setShowTenantReceipt(true);
                          }}
                          className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm whitespace-nowrap ${
                            sig.status === 'signed'
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                              : 'border-amber-300 bg-amber-50 text-amber-700'
                          }`}
                          title="Open signing receipt"
                        >
                          <span className={`w-2.5 h-2.5 rounded-full ${sig.status === 'signed' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                          <span className="font-semibold text-slate-900">{sig.name}</span>
                          <span className="text-slate-500">· {sig.role}</span>
                          <span className="italic">{sig.status === 'signed' && sig.signedAt ? `Signed ${new Date(sig.signedAt).toLocaleDateString()}` : 'Awaiting'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex-1 overflow-hidden bg-slate-800">
                  {loadingSignedDoc ? (
                    <div className="flex items-center justify-center py-12 h-full bg-white">
                      <svg className="animate-spin h-8 w-8 text-purple-600" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                    </div>
                  ) : (
                    <iframe
                      src={getDocumentViewerUrl(viewingDocument)}
                      title={viewingDocument.metadata?.fileName || viewingDocument.title}
                      className="w-full h-full border-0 bg-white"
                    />
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-slate-200 bg-white">
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={() => handleTenantDocumentDownload(viewingDocument)}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v1a2 2 0 002 2h12a2 2 0 002-2v-1" />
                      </svg>
                      Download
                    </button>
                    {viewingDocument.status === 'completed' && (
                      <button
                        onClick={() => {
                          setTenantReceiptDocId(viewingDocument.id);
                          setShowTenantReceipt(true);
                        }}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6M7 4h10a2 2 0 012 2v12a2 2 0 01-2 2H7a2 2 0 01-2-2V6a2 2 0 012-2z" />
                        </svg>
                        Signing Receipt
                      </button>
                    )}
                  </div>
                  <button
                    onClick={closeDocumentViewer}
                    className="px-4 py-2 text-slate-700 hover:bg-slate-100 rounded-xl transition-colors"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Signing Receipt Modal */}
          {showTenantReceipt && tenantReceiptDocId && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setShowTenantReceipt(false)}>
              <div
                style={{ width: '100%', maxWidth: '940px', maxHeight: '90vh', overflow: 'auto', borderRadius: '12px' }}
                onClick={(e) => e.stopPropagation()}
              >
                <SigningReceipt
                  documentId={tenantReceiptDocId}
                  onClose={() => {
                    setShowTenantReceipt(false);
                    setTenantReceiptDocId(null);
                  }}
                />
              </div>
            </div>
          )}

          {showProfileModal && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setShowProfileModal(false)}>
              <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-gray-200">
                  <div>
                    <h3 className="font-bold text-lg text-gray-900">Your Profile</h3>
                    <p className="text-sm text-gray-500">Manage your photo and account details</p>
                  </div>
                  <button
                    onClick={() => setShowProfileModal(false)}
                    className="text-gray-400 hover:text-gray-600 p-2 rounded-lg hover:bg-gray-100"
                  >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                <div className="p-6">
                  <div className="bg-gradient-to-br from-purple-50 to-white rounded-xl p-8 border border-purple-100 mb-6">
                    <ProfilePhotoUpload
                      currentPhotoURL={profilePhotoURL}
                      userId={user.id}
                      userName={user.name}
                      onPhotoUpdated={(newPhotoURL) => {
                        setProfilePhotoURL(newPhotoURL);
                      }}
                    />
                  </div>

                  <div className="bg-white rounded-xl border border-gray-200 p-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Account Information</h3>
                    <div className="space-y-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                        <div className="px-4 py-2 bg-gray-50 rounded-lg text-gray-900">{user.name}</div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                        <div className="px-4 py-2 bg-gray-50 rounded-lg text-gray-900">{user.email}</div>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Property</label>
                        <div className="px-4 py-2 bg-gray-50 rounded-lg text-gray-900">
                          {user.propertyAddress || propertyDetails?.address || 'N/A'}
                        </div>
                      </div>
                      {(user.unit || propertyDetails?.unit) && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Unit</label>
                          <div className="px-4 py-2 bg-gray-50 rounded-lg text-gray-900">
                            {user.unit || propertyDetails?.unit}
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                      <div className="flex items-start gap-2">
                        <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                        </svg>
                        <div className="text-sm text-blue-900">
                          <p className="font-medium mb-1">Profile Photo Tips</p>
                          <ul className="list-disc list-inside space-y-1 text-blue-800">
                            <li>Use a clear photo of yourself for better communication with your landlord</li>
                            <li>If you signed up with Google, your Google photo is automatically used</li>
                            <li>You can update your photo anytime by clicking the camera icon</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
