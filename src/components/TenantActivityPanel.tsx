import { useState, useEffect } from 'react';

interface TenantMessage {
  id: string;
  tenantId: string;
  tenantEmail: string;
  tenantName: string;
  unit?: string;
  subject?: string;
  message: string;
  status: 'unread' | 'read';
  createdAt: string;
}

interface MaintenanceRequest {
  id: string;
  tenantId: string;
  tenantEmail: string;
  tenantName: string;
  unit?: string;
  category: string;
  priority: string;
  location?: string;
  description: string;
  status: 'pending' | 'in_progress' | 'scheduled' | 'completed';
  createdAt: string;
  photos?: string[];
}

interface TenantPayment {
  id: string;
  tenantId: string;
  tenantName: string;
  unit?: string;
  amount: number;
  status: 'completed' | 'pending' | 'failed';
  paymentDate: string;
}

function normalizeOwnerPayments(rawPayments: any[]): TenantPayment[] {
  return rawPayments.map((pay) => ({
    id: pay.id,
    tenantId: pay.tenantId || '',
    tenantName: pay.tenantName || pay.tenantEmail || 'Tenant',
    unit: pay.unit,
    amount: pay.amount,
    status: pay.status === 'completed' ? 'completed' : pay.status === 'failed' ? 'failed' : 'pending',
    paymentDate: pay.paymentDate || pay.date || pay.createdAt || new Date().toISOString(),
  }));
}

async function fetchOwnerPayments(ownerId: string, propertyId?: string): Promise<TenantPayment[]> {
  const baseUrl = propertyId ? `&propertyId=${encodeURIComponent(propertyId)}` : '';

  const paymentsRes = await fetch(`/api/owner/payments?ownerId=${encodeURIComponent(ownerId)}${baseUrl}`);
  const paymentsData = await paymentsRes.json();

  if (paymentsData.ok && paymentsData.payments?.length > 0) {
    return normalizeOwnerPayments(paymentsData.payments);
  }

  // Fallback: pull directly from Stripe when Firestore has no matching records
  try {
    const acctRes = await fetch(`/api/stripe-connect/accounts/${encodeURIComponent(ownerId)}`);
    const acctData = await acctRes.json();
    const accts = acctData.accounts || acctData;
    const accountId = Array.isArray(accts) && accts.length
      ? (accts[0].accountId || accts[0].id)
      : null;

    if (!accountId) return [];

    const stripeRes = await fetch(`/api/stripe-connect/owner-payment-history?accountId=${encodeURIComponent(accountId)}`);
    const stripeData = await stripeRes.json();
    if (stripeData.ok && stripeData.payments?.length > 0) {
      return normalizeOwnerPayments(stripeData.payments);
    }
  } catch (_err) {
    /* non-critical fallback */
  }

  return [];
}

interface TenantActivityPanelProps {
  ownerId: string;
  propertyId?: string;
  tenantId?: string; // If provided, show activity for specific tenant
  compact?: boolean;
}

export default function TenantActivityPanel({
  ownerId,
  propertyId,
  tenantId,
  compact = false
}: TenantActivityPanelProps) {
  const [activeTab, setActiveTab] = useState<'messages' | 'maintenance' | 'payments'>('messages');
  const [messages, setMessages] = useState<TenantMessage[]>([]);
  const [maintenanceRequests, setMaintenanceRequests] = useState<MaintenanceRequest[]>([]);
  const [payments, setPayments] = useState<TenantPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingMaintenanceCount, setPendingMaintenanceCount] = useState(0);

  useEffect(() => {
    fetchAllActivity();
  }, [ownerId, propertyId, tenantId]);

  const fetchAllActivity = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const baseUrl = propertyId ? `&propertyId=${encodeURIComponent(propertyId)}` : '';
      
      // Fetch all types of activity in parallel
      const [messagesRes, maintenanceRes] = await Promise.all([
        fetch(`/api/owner/messages?ownerId=${encodeURIComponent(ownerId)}${baseUrl}`),
        fetch(`/api/owner/maintenance?ownerId=${encodeURIComponent(ownerId)}${baseUrl}`),
      ]);

      const [messagesData, maintenanceData, pays] = await Promise.all([
        messagesRes.json(),
        maintenanceRes.json(),
        fetchOwnerPayments(ownerId, propertyId),
      ]);

      if (messagesData.ok) {
        let msgs = messagesData.messages || [];
        if (tenantId) {
          msgs = msgs.filter((m: TenantMessage) => m.tenantId === tenantId);
        }
        setMessages(msgs);
        setUnreadCount(msgs.filter((m: TenantMessage) => m.status === 'unread').length);
      }

      if (maintenanceData.ok) {
        let reqs = maintenanceData.requests || [];
        if (tenantId) {
          reqs = reqs.filter((r: MaintenanceRequest) => r.tenantId === tenantId);
        }
        setMaintenanceRequests(reqs);
        setPendingMaintenanceCount(reqs.filter((r: MaintenanceRequest) => r.status === 'pending').length);
      }

      let filteredPayments = pays;
      if (tenantId) {
        filteredPayments = filteredPayments.filter((p) => p.tenantId === tenantId);
      }
      setPayments(filteredPayments);
    } catch (err) {
      console.error('[TenantActivityPanel] Error fetching activity:', err);
      setError('Failed to load tenant activity');
    } finally {
      setLoading(false);
    }
  };

  const markMessageRead = async (messageId: string) => {
    try {
      await fetch(`/api/owner/messages/${messageId}/read`, { method: 'PUT' });
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, status: 'read' as const } : m
      ));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (err) {
      console.error('Failed to mark message read:', err);
    }
  };

  const updateMaintenanceStatus = async (requestId: string, status: string) => {
    try {
      const response = await fetch(`/api/owner/maintenance/${requestId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      
      if ((await response.json()).ok) {
        setMaintenanceRequests(prev => prev.map(r => 
          r.id === requestId ? { ...r, status: status as MaintenanceRequest['status'] } : r
        ));
        if (status !== 'pending') {
          setPendingMaintenanceCount(prev => Math.max(0, prev - 1));
        }
      }
    } catch (err) {
      console.error('Failed to update maintenance status:', err);
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'bg-red-100 text-red-700';
      case 'normal': return 'bg-yellow-100 text-yellow-700';
      case 'low': return 'bg-green-100 text-green-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return 'bg-yellow-100 text-yellow-700';
      case 'in_progress': return 'bg-blue-100 text-blue-700';
      case 'scheduled': return 'bg-purple-100 text-purple-700';
      case 'completed': return 'bg-green-100 text-green-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <svg className="animate-spin h-6 w-6 text-purple-600" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
        </svg>
        <span className="ml-2 text-gray-600">Loading tenant activity...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8 text-red-600">
        {error}
        <button onClick={fetchAllActivity} className="ml-2 underline">Retry</button>
      </div>
    );
  }

  return (
    <div className={`bg-white rounded-xl shadow-sm border ${compact ? 'p-4' : 'p-6'}`}>
      {/* Header with tabs */}
      <div className="flex items-center justify-between mb-4">
        <h3 className={`font-semibold ${compact ? 'text-base' : 'text-lg'}`}>Tenant Activity</h3>
        <button 
          onClick={fetchAllActivity}
          className="text-sm text-purple-600 hover:text-purple-700"
        >
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-4">
        <button
          onClick={() => setActiveTab('messages')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'messages' 
              ? 'border-purple-600 text-purple-600' 
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Messages
          {unreadCount > 0 && (
            <span className="ml-2 px-2 py-0.5 text-xs bg-red-500 text-white rounded-full">
              {unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('maintenance')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'maintenance' 
              ? 'border-purple-600 text-purple-600' 
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Maintenance
          {pendingMaintenanceCount > 0 && (
            <span className="ml-2 px-2 py-0.5 text-xs bg-yellow-500 text-white rounded-full">
              {pendingMaintenanceCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('payments')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'payments' 
              ? 'border-purple-600 text-purple-600' 
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Payments
        </button>
      </div>

      {/* Content */}
      <div className={`${compact ? 'max-h-64' : 'max-h-96'} overflow-y-auto`}>
        {/* Messages Tab */}
        {activeTab === 'messages' && (
          <div className="space-y-3">
            {messages.length === 0 ? (
              <div className="text-center py-6 text-gray-500">
                <svg className="w-12 h-12 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                </svg>
                No messages from tenants yet
              </div>
            ) : (
              messages.map(msg => (
                <div 
                  key={msg.id} 
                  className={`p-3 rounded-lg border ${msg.status === 'unread' ? 'bg-purple-50 border-purple-200' : 'bg-gray-50 border-gray-200'}`}
                  onClick={() => msg.status === 'unread' && markMessageRead(msg.id)}
                >
                  <div className="flex items-start justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{msg.tenantName}</span>
                      {msg.unit && <span className="text-xs text-gray-500">Unit {msg.unit}</span>}
                      {msg.status === 'unread' && (
                        <span className="w-2 h-2 bg-purple-600 rounded-full"></span>
                      )}
                    </div>
                    <span className="text-xs text-gray-400">
                      {new Date(msg.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  {msg.subject && <div className="text-sm font-medium text-gray-700 mb-1">{msg.subject}</div>}
                  <p className="text-sm text-gray-600 line-clamp-2">{msg.message}</p>
                </div>
              ))
            )}
          </div>
        )}

        {/* Maintenance Tab */}
        {activeTab === 'maintenance' && (
          <div className="space-y-3">
            {maintenanceRequests.length === 0 ? (
              <div className="text-center py-6 text-gray-500">
                <svg className="w-12 h-12 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                No maintenance requests
              </div>
            ) : (
              maintenanceRequests.map(req => (
                <div key={req.id} className="p-3 rounded-lg border bg-gray-50 border-gray-200">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">{req.category}</span>
                        <span className={`px-2 py-0.5 text-xs rounded-full ${getPriorityColor(req.priority)}`}>
                          {req.priority}
                        </span>
                        <span className={`px-2 py-0.5 text-xs rounded-full ${getStatusColor(req.status)}`}>
                          {req.status.replace('_', ' ')}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {req.tenantName} {req.unit && `• Unit ${req.unit}`}
                      </div>
                    </div>
                    <span className="text-xs text-gray-400">
                      {new Date(req.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mb-2 line-clamp-2">{req.description}</p>
                  {req.location && <p className="text-xs text-gray-500 mb-2">Location: {req.location}</p>}
                  
                  {/* Status actions */}
                  {req.status === 'pending' && (
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => updateMaintenanceStatus(req.id, 'in_progress')}
                        className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                      >
                        Start Work
                      </button>
                      <button
                        onClick={() => updateMaintenanceStatus(req.id, 'scheduled')}
                        className="px-2 py-1 text-xs bg-purple-100 text-purple-700 rounded hover:bg-purple-200"
                      >
                        Schedule
                      </button>
                    </div>
                  )}
                  {(req.status === 'in_progress' || req.status === 'scheduled') && (
                    <button
                      onClick={() => updateMaintenanceStatus(req.id, 'completed')}
                      className="px-2 py-1 text-xs bg-green-100 text-green-700 rounded hover:bg-green-200"
                    >
                      Mark Complete
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Payments Tab */}
        {activeTab === 'payments' && (
          <div className="space-y-3">
            {payments.length === 0 ? (
              <div className="text-center py-6 text-gray-500">
                <svg className="w-12 h-12 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                No payment history yet
              </div>
            ) : (
              payments.map(pay => (
                <div key={pay.id} className="p-3 rounded-lg border bg-gray-50 border-gray-200 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{pay.tenantName}</span>
                      {pay.unit && <span className="text-xs text-gray-500">Unit {pay.unit}</span>}
                    </div>
                    <div className="text-xs text-gray-400">
                      {new Date(pay.paymentDate).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-semibold ${pay.status === 'completed' ? 'text-green-600' : pay.status === 'failed' ? 'text-red-600' : 'text-yellow-600'}`}>
                      ${pay.amount.toLocaleString()}
                    </div>
                    <div className={`text-xs ${pay.status === 'completed' ? 'text-green-500' : pay.status === 'failed' ? 'text-red-500' : 'text-yellow-500'}`}>
                      {pay.status}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
