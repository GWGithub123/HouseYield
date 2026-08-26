/**
 * Tenant Activity Service
 * 
 * Tracks and stores tenant activities in Firestore:
 * - Maintenance requests
 * - Messages to property owner
 * - Payment history
 * - Document submissions
 * 
 * Organized by tenant for easy display on property owner dashboard
 */

import { initializeFirebaseAdmin, getFirestore } from './firebase-admin.js';
import {
  formatAvailabilityWindows,
  mergeIntake,
  mergePropertyAccess,
  normalizeAvailabilityWindows,
  normalizeOperatorLog,
  normalizeSubmittedBy,
} from './maintenance/requestSchema.js';
import { mergeMaintenanceOutcome, mergeServiceRecord } from './maintenance/serviceRecord.js';

export { formatAvailabilityWindows, MAINTENANCE_ACCESS_METHODS } from './maintenance/requestSchema.js';

// Initialize Firebase Admin
initializeFirebaseAdmin();
const db = getFirestore();

// Collection references
const TENANT_MESSAGES_COLLECTION = 'tenantMessages';
const MAINTENANCE_REQUESTS_COLLECTION = 'maintenanceRequests';
const PAYMENT_HISTORY_COLLECTION = 'tenantPayments';

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function buildDefaultMaintenancePaymentWorkflow() {
  return {
    status: 'not_started',
    amount: null,
    currency: 'usd',
    serviceSummary: '',
    receiptNumber: '',
    contractorStripeAccountId: '',
    contractorStripeUserKey: '',
    contractorOnboardingLinkSentAt: null,
    contractorOnboardingCompletedAt: null,
    ownerEmail: '',
    ownerName: '',
    ownerBillingCustomerId: '',
    ownerBillingSetupCompletedAt: null,
    ownerChargeRequestedAt: null,
    ownerChargeSucceededAt: null,
    ownerInvoiceId: '',
    ownerInvoiceUrl: '',
    ownerPaymentIntentId: '',
    ownerPaymentMethodId: '',
    ownerPaymentMethodLast4: '',
    ownerPaymentMethodBankName: '',
    ownerPaymentStatus: '',
    paymentMethod: 'us_bank_account',
    receiptUrl: '',
    lastError: '',
    emails: {
      contractorInviteSentAt: null,
      contractorReceiptSentAt: null,
      ownerInvoiceSentAt: null,
      ownerReceiptSentAt: null,
    },
  };
}

function mergeMaintenancePaymentWorkflow(existing = null, updates = null) {
  if (!updates && !existing) {
    return buildDefaultMaintenancePaymentWorkflow();
  }

  const base = buildDefaultMaintenancePaymentWorkflow();
  const current = existing && typeof existing === 'object' ? existing : {};
  const next = updates && typeof updates === 'object' ? updates : {};

  return {
    ...base,
    ...current,
    ...next,
    emails: {
      ...base.emails,
      ...(current.emails || {}),
      ...(next.emails || {}),
    },
  };
}

function mergeContractorAssignment(existing = null, updates = null) {
  if (!updates && !existing) {
    return null;
  }

  return {
    contractorId: '',
    contractorEmail: '',
    contractorName: '',
    contractorCompanyName: '',
    assignedAt: null,
    serviceCompletedAt: null,
    ...((existing && typeof existing === 'object') ? existing : {}),
    ...((updates && typeof updates === 'object') ? updates : {}),
  };
}

function mergeServiceCompletion(existing = null, updates = null) {
  if (!updates && !existing) {
    return null;
  }

  return {
    completedAt: null,
    completedBy: '',
    notes: '',
    ...((existing && typeof existing === 'object') ? existing : {}),
    ...((updates && typeof updates === 'object') ? updates : {}),
  };
}

/** Applies the read-side defaults every maintenance consumer can rely on. */
function normalizeMaintenanceRequest(request) {
  request.paymentWorkflow = mergeMaintenancePaymentWorkflow(request.paymentWorkflow);
  request.contractorAssignment = mergeContractorAssignment(request.contractorAssignment);
  request.serviceCompletion = mergeServiceCompletion(request.serviceCompletion);
  request.propertyAccess = mergePropertyAccess(request.propertyAccess);
  request.intake = mergeIntake(request.intake);
  request.availabilityWindows = normalizeAvailabilityWindows(request.availabilityWindows);
  request.submittedBy = normalizeSubmittedBy(request.submittedBy);
  request.operatorLog = normalizeOperatorLog(request.operatorLog);
  // Left null when absent so the UI can distinguish "no visit yet" from an empty record.
  request.serviceRecord = request.serviceRecord ? mergeServiceRecord(request.serviceRecord) : null;
  request.outcome = request.outcome ? mergeMaintenanceOutcome(request.outcome) : null;
  return request;
}

/**
 * Save a message from tenant to property owner
 * @param {Object} messageData
 * @returns {Promise<{ok: boolean, messageId?: string, error?: string}>}
 */
export async function saveTenantMessage({
  tenantId,
  tenantEmail,
  tenantName,
  ownerId,
  propertyId,
  propertyAddress,
  unit,
  message,
  subject = 'General Inquiry',
  senderType = 'tenant',
  direction = 'outbound',
  inReplyTo = null,
  ownerVisible = true,
  tenantVisible = true
}) {
  try {
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const messageRecord = {
      id: messageId,
      tenantId,
      tenantEmail,
      tenantName,
      ownerId,
      propertyId,
      propertyAddress,
      unit: unit || '',
      subject,
      message,
      senderType,
      direction,
      inReplyTo,
      ownerVisible,
      tenantVisible,
      status: 'unread',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await db.collection(TENANT_MESSAGES_COLLECTION).doc(messageId).set(messageRecord);
    
    console.log('[TenantActivity] Saved message from tenant:', tenantId, 'to owner:', ownerId);
    
    return { ok: true, messageId, message: messageRecord };
  } catch (error) {
    console.error('[TenantActivity] Error saving message:', error);
    return { ok: false, error: error.message || 'Failed to save message' };
  }
}

/**
 * Get all messages for a property owner (grouped by tenant)
 * @param {string} ownerId
 * @param {string} propertyId - Optional: filter by specific property
 * @returns {Promise<{ok: boolean, messages?: Array, error?: string}>}
 */
export async function getOwnerMessages(ownerId, propertyId = null) {
  try {
    let query = db.collection(TENANT_MESSAGES_COLLECTION)
      .where('ownerId', '==', ownerId);
    
    if (propertyId) {
      query = query.where('propertyId', '==', propertyId);
    }
    
    const snapshot = await query.get();
    
    const messages = [];
    snapshot.forEach(doc => {
      const data = doc.data() || {};
      if (data.ownerVisible === false) return;
      messages.push({ id: doc.id, ...data });
    });
    
    // Sort by createdAt descending
    messages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    // Group by tenant for easy display
    const byTenant = {};
    messages.forEach(msg => {
      const key = msg.tenantId || msg.tenantEmail;
      if (!byTenant[key]) {
        byTenant[key] = {
          tenantId: msg.tenantId,
          tenantEmail: msg.tenantEmail,
          tenantName: msg.tenantName,
          unit: msg.unit,
          messages: [],
          unreadCount: 0
        };
      }
      byTenant[key].messages.push(msg);
      if (msg.status === 'unread') {
        byTenant[key].unreadCount++;
      }
    });
    
    return { 
      ok: true, 
      messages, 
      byTenant: Object.values(byTenant),
      totalUnread: messages.filter(m => m.status === 'unread').length
    };
  } catch (error) {
    console.error('[TenantActivity] Error getting messages:', error);
    return { ok: false, error: error.message || 'Failed to get messages' };
  }
}

/**
 * Mark message as read
 * @param {string} messageId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function markMessageRead(messageId) {
  try {
    await db.collection(TENANT_MESSAGES_COLLECTION).doc(messageId).update({
      status: 'read',
      readAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    return { ok: true };
  } catch (error) {
    console.error('[TenantActivity] Error marking message read:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Save a maintenance request
 * @param {Object} requestData
 * @returns {Promise<{ok: boolean, requestId?: string, error?: string}>}
 */
export async function saveMaintenanceRequest({
  tenantId,
  tenantEmail,
  tenantName,
  ownerId,
  propertyId,
  propertyAddress,
  unit,
  serviceType,
  category,
  priority,
  location,
  description,
  tenantAvailability = '',
  photos = [],
  triageSummary = '',
  triageTranscript = [],
  emergencyGuidance = '',
  suggestedActions = [],
  liveAssistantSummary = '',
  applianceInfo = null,
  applianceTroubleshooting = null,
  intake = null,
  propertyAccess = null,
  availabilityWindows = [],
  submittedBy = null
}) {
  try {
    const requestId = `maint_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const normalizedAvailabilityWindows = normalizeAvailabilityWindows(availabilityWindows);
    const availabilitySummary = tenantAvailability || formatAvailabilityWindows(normalizedAvailabilityWindows);
    
    const requestRecord = {
      id: requestId,
      tenantId,
      tenantEmail,
      tenantName,
      ownerId,
      propertyId,
      propertyAddress,
      unit: unit || '',
      serviceType: serviceType || '',
      category,
      priority: priority || 'normal',
      location: location || '',
      description,
      tenantAvailability: availabilitySummary,
      availabilityWindows: normalizedAvailabilityWindows,
      propertyAccess: mergePropertyAccess(null, propertyAccess),
      intake: mergeIntake(null, intake),
      submittedBy: normalizeSubmittedBy(submittedBy),
      operatorLog: [],
      photos: photos || [],
      triageSummary: triageSummary || '',
      triageTranscript: Array.isArray(triageTranscript) ? triageTranscript : [],
      emergencyGuidance: emergencyGuidance || '',
      suggestedActions: Array.isArray(suggestedActions) ? suggestedActions : [],
      liveAssistantSummary: liveAssistantSummary || '',
      applianceInfo: applianceInfo || null,
      applianceTroubleshooting: applianceTroubleshooting || null,
      contractorId: '',
      contractorEmail: '',
      contractorName: '',
      contractorCompanyName: '',
      contractorAssignment: null,
      serviceCompletion: null,
      paymentWorkflow: buildDefaultMaintenancePaymentWorkflow(),
      aiAutomation: {
        status: 'pending',
        providerSearch: null,
        selectedProvider: null,
        callInitiated: false,
        usedTrustedProvider: false
      },
      status: 'pending', // pending, in_progress, scheduled, completed
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(requestId).set(requestRecord);
    
    console.log('[TenantActivity] Saved maintenance request from tenant:', tenantId, 'Category:', category);
    
    return { ok: true, requestId, request: requestRecord };
  } catch (error) {
    console.error('[TenantActivity] Error saving maintenance request:', error);
    return { ok: false, error: error.message || 'Failed to save maintenance request' };
  }
}

export async function updateMaintenanceAutomation(requestId, {
  aiAutomation = null,
  tenantAvailability = undefined,
  serviceType = undefined
} = {}) {
  try {
    const updateData = {
      updatedAt: new Date().toISOString()
    };

    if (aiAutomation) {
      updateData.aiAutomation = aiAutomation;
    }
    if (tenantAvailability !== undefined) {
      updateData.tenantAvailability = tenantAvailability;
    }
    if (serviceType !== undefined) {
      updateData.serviceType = serviceType;
    }

    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(requestId).update(updateData);
    return { ok: true };
  } catch (error) {
    console.error('[TenantActivity] Error updating maintenance automation:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get all maintenance requests for a property owner (grouped by tenant/property)
 * @param {string} ownerId
 * @param {string} propertyId - Optional: filter by specific property
 * @returns {Promise<{ok: boolean, requests?: Array, error?: string}>}
 */
export async function getOwnerMaintenanceRequests(ownerId, propertyId = null) {
  try {
    let query = db.collection(MAINTENANCE_REQUESTS_COLLECTION)
      .where('ownerId', '==', ownerId);
    
    if (propertyId) {
      query = query.where('propertyId', '==', propertyId);
    }
    
    const snapshot = await query.get();
    
    const requests = [];
    snapshot.forEach(doc => {
      requests.push(normalizeMaintenanceRequest({ id: doc.id, ...doc.data() }));
    });
    
    // Sort by createdAt descending
    requests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    // Group by tenant for easy display
    const byTenant = {};
    requests.forEach(req => {
      const key = req.tenantId || req.tenantEmail;
      if (!byTenant[key]) {
        byTenant[key] = {
          tenantId: req.tenantId,
          tenantEmail: req.tenantEmail,
          tenantName: req.tenantName,
          unit: req.unit,
          requests: [],
          pendingCount: 0
        };
      }
      byTenant[key].requests.push(req);
      if (req.status === 'pending') {
        byTenant[key].pendingCount++;
      }
    });
    
    return { 
      ok: true, 
      requests, 
      byTenant: Object.values(byTenant),
      totalPending: requests.filter(r => r.status === 'pending').length
    };
  } catch (error) {
    console.error('[TenantActivity] Error getting maintenance requests:', error);
    return { ok: false, error: error.message || 'Failed to get maintenance requests' };
  }
}

/**
 * Update maintenance request status
 * @param {string} requestId
 * @param {string} status
 * @param {string} notes - Optional notes
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function updateMaintenanceStatus(requestId, status, notes = null) {
  try {
    const updateData = {
      status,
      updatedAt: new Date().toISOString()
    };
    
    if (notes) {
      updateData.ownerNotes = notes;
    }
    
    if (status === 'completed') {
      updateData.completedAt = new Date().toISOString();
    }
    
    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(requestId).update(updateData);
    return { ok: true };
  } catch (error) {
    console.error('[TenantActivity] Error updating maintenance status:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get a single maintenance request by ID
 * @param {string} requestId
 * @returns {Promise<{ok: boolean, request?: Object, error?: string}>}
 */
export async function getMaintenanceRequestById(requestId) {
  try {
    const docRef = db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(requestId);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      return { ok: false, error: 'Maintenance request not found' };
    }

    const request = normalizeMaintenanceRequest({ id: snapshot.id, ...snapshot.data() });

    return { ok: true, request };
  } catch (error) {
    console.error('[TenantActivity] Error getting maintenance request by ID:', error);
    return { ok: false, error: error.message || 'Failed to get maintenance request' };
  }
}

/**
 * Update a maintenance request with payout, contractor, or receipt metadata.
 * @param {string} requestId
 * @param {Object} updates
 * @returns {Promise<{ok: boolean, request?: Object, error?: string}>}
 */
export async function updateMaintenanceRequestDetails(requestId, updates = {}) {
  try {
    const docRef = db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(requestId);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      return { ok: false, error: 'Maintenance request not found' };
    }

    const existing = snapshot.data() || {};
    const mergedContractorAssignment = Object.prototype.hasOwnProperty.call(updates, 'contractorAssignment')
      ? mergeContractorAssignment(existing.contractorAssignment, updates.contractorAssignment)
      : existing.contractorAssignment || null;
    const mergedServiceCompletion = Object.prototype.hasOwnProperty.call(updates, 'serviceCompletion')
      ? mergeServiceCompletion(existing.serviceCompletion, updates.serviceCompletion)
      : existing.serviceCompletion || null;
    const mergedPaymentWorkflow = Object.prototype.hasOwnProperty.call(updates, 'paymentWorkflow')
      ? mergeMaintenancePaymentWorkflow(existing.paymentWorkflow, updates.paymentWorkflow)
      : mergeMaintenancePaymentWorkflow(existing.paymentWorkflow);

    const updateData = {
      ...updates,
      updatedAt: new Date().toISOString(),
      contractorAssignment: mergedContractorAssignment,
      serviceCompletion: mergedServiceCompletion,
      paymentWorkflow: mergedPaymentWorkflow,
    };

    if (Object.prototype.hasOwnProperty.call(updates, 'propertyAccess')) {
      updateData.propertyAccess = mergePropertyAccess(existing.propertyAccess, updates.propertyAccess);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'intake')) {
      updateData.intake = mergeIntake(existing.intake, updates.intake);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'availabilityWindows')) {
      updateData.availabilityWindows = normalizeAvailabilityWindows(updates.availabilityWindows);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'submittedBy')) {
      updateData.submittedBy = normalizeSubmittedBy(updates.submittedBy);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'operatorLog')) {
      updateData.operatorLog = normalizeOperatorLog(updates.operatorLog);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'serviceRecord')) {
      updateData.serviceRecord = mergeServiceRecord(existing.serviceRecord, updates.serviceRecord);
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'outcome')) {
      updateData.outcome = mergeMaintenanceOutcome(existing.outcome, updates.outcome);
    }

    if (Object.prototype.hasOwnProperty.call(updates, 'contractorEmail')) {
      updateData.contractorEmail = normalizeEmail(updates.contractorEmail);
    } else if (typeof existing.contractorEmail === 'string') {
      updateData.contractorEmail = normalizeEmail(existing.contractorEmail);
    }

    if (updateData.contractorAssignment?.contractorEmail) {
      updateData.contractorAssignment = {
        ...updateData.contractorAssignment,
        contractorEmail: normalizeEmail(updateData.contractorAssignment.contractorEmail),
      };
    }

    await docRef.set(updateData, { merge: true });

    return {
      ok: true,
      request: {
        id: snapshot.id,
        ...existing,
        ...updateData,
      },
    };
  } catch (error) {
    console.error('[TenantActivity] Error updating maintenance request details:', error);
    return { ok: false, error: error.message || 'Failed to update maintenance request' };
  }
}

/**
 * Cross-account maintenance queue for the HouseYield operator console. Unlike the
 * owner/tenant readers this is deliberately unscoped, so it must only be reached
 * through a staff-guarded route.
 * @param {Object} options
 * @returns {Promise<{ok: boolean, requests?: Array, error?: string}>}
 */
export async function getAllMaintenanceRequests({
  status = null,
  priority = null,
  ownerId = null,
  limit = 300,
} = {}) {
  try {
    let query = db.collection(MAINTENANCE_REQUESTS_COLLECTION);

    // Single equality filter keeps this on the automatic single-field indexes.
    if (ownerId) {
      query = query.where('ownerId', '==', ownerId);
    }

    const snapshot = await query.get();
    let requests = [];
    snapshot.forEach((doc) => {
      requests.push(normalizeMaintenanceRequest({ id: doc.id, ...doc.data() }));
    });

    if (status) {
      const wanted = Array.isArray(status) ? status : [status];
      requests = requests.filter((request) => wanted.includes(request.status));
    }
    if (priority) {
      const wanted = Array.isArray(priority) ? priority : [priority];
      requests = requests.filter((request) => wanted.includes(request.priority));
    }

    requests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(1000, Number(limit))) : 300;

    return { ok: true, requests: requests.slice(0, cap), total: requests.length };
  } catch (error) {
    console.error('[TenantActivity] Error listing all maintenance requests:', error);
    return { ok: false, error: error.message || 'Failed to list maintenance requests' };
  }
}

/**
 * Append an audit entry to a request's operator log.
 * @param {string} requestId
 * @param {Object} entry
 * @returns {Promise<{ok: boolean, operatorLog?: Array, error?: string}>}
 */
export async function appendMaintenanceOperatorLog(requestId, entry = {}) {
  try {
    const docRef = db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(requestId);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      return { ok: false, error: 'Maintenance request not found' };
    }

    const existing = normalizeOperatorLog(snapshot.data()?.operatorLog);
    const [normalizedEntry] = normalizeOperatorLog([{ at: new Date().toISOString(), ...entry }]);

    if (!normalizedEntry) {
      return { ok: false, error: 'Operator log entry requires an event' };
    }

    const operatorLog = [...existing, normalizedEntry];
    await docRef.set({ operatorLog, updatedAt: new Date().toISOString() }, { merge: true });

    return { ok: true, operatorLog };
  } catch (error) {
    console.error('[TenantActivity] Error appending operator log:', error);
    return { ok: false, error: error.message || 'Failed to append operator log' };
  }
}

/**
 * Get maintenance requests assigned to a contractor.
 * @param {string} contractorId
 * @param {string} contractorEmail
 * @returns {Promise<{ok: boolean, requests?: Array, error?: string}>}
 */
export async function getContractorMaintenanceRequests(contractorId = '', contractorEmail = '') {
  try {
    const normalizedEmail = normalizeEmail(contractorEmail);
    const resultsById = new Map();

    if (contractorId) {
      const byIdSnapshot = await db.collection(MAINTENANCE_REQUESTS_COLLECTION)
        .where('contractorId', '==', contractorId)
        .get();
      byIdSnapshot.forEach((doc) => {
        resultsById.set(doc.id, { id: doc.id, ...doc.data() });
      });
    }

    if (normalizedEmail) {
      const byEmailSnapshot = await db.collection(MAINTENANCE_REQUESTS_COLLECTION)
        .where('contractorEmail', '==', normalizedEmail)
        .get();
      byEmailSnapshot.forEach((doc) => {
        resultsById.set(doc.id, { id: doc.id, ...doc.data() });
      });
    }

    const requests = [...resultsById.values()]
      .map((request) => normalizeMaintenanceRequest({ ...request }))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());

    return { ok: true, requests };
  } catch (error) {
    console.error('[TenantActivity] Error getting contractor maintenance requests:', error);
    return { ok: false, error: error.message || 'Failed to get contractor maintenance requests' };
  }
}

/**
 * Record a tenant payment
 * @param {Object} paymentData
 * @returns {Promise<{ok: boolean, paymentId?: string, error?: string}>}
 */
export async function recordTenantPayment({
  tenantId,
  tenantEmail,
  tenantName,
  ownerId,
  propertyId,
  propertyAddress,
  unit,
  amount,
  paymentMethod,
  transactionId,
  status = 'completed',
  paymentDate = null
}) {
  try {
    const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const paymentRecord = {
      id: paymentId,
      tenantId,
      tenantEmail,
      tenantName,
      ownerId,
      propertyId,
      propertyAddress,
      unit: unit || '',
      amount,
      paymentMethod: paymentMethod || 'card',
      transactionId: transactionId || null,
      status, // completed, pending, failed
      paymentDate: paymentDate || new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    
    await db.collection(PAYMENT_HISTORY_COLLECTION).doc(paymentId).set(paymentRecord);
    
    console.log('[TenantActivity] Recorded payment from tenant:', tenantId, 'Amount:', amount);
    
    return { ok: true, paymentId, payment: paymentRecord };
  } catch (error) {
    console.error('[TenantActivity] Error recording payment:', error);
    return { ok: false, error: error.message || 'Failed to record payment' };
  }
}

/**
 * Update payment status by Stripe transaction ID (payment intent ID)
 * @param {string} transactionId - Stripe payment intent ID
 * @param {string} status - 'completed' | 'pending' | 'failed'
 * @returns {Promise<{ok: boolean, updated?: boolean, error?: string}>}
 */
export async function updateTenantPaymentStatus(transactionId, status) {
  try {
    const snap = await db.collection(PAYMENT_HISTORY_COLLECTION)
      .where('transactionId', '==', transactionId)
      .limit(1)
      .get();

    if (snap.empty) {
      return { ok: true, updated: false };
    }

    await snap.docs[0].ref.update({ status, updatedAt: new Date().toISOString() });
    console.log('[TenantActivity] Updated payment status:', transactionId, '->', status);
    return { ok: true, updated: true };
  } catch (error) {
    console.error('[TenantActivity] Error updating payment status:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get payment history for owner (grouped by tenant)
 * @param {string} ownerId
 * @param {string} propertyId - Optional
 * @returns {Promise<{ok: boolean, payments?: Array, error?: string}>}
 */
export async function getOwnerPaymentHistory(ownerId, propertyId = null) {
  try {
    const snapshot = await db.collection(PAYMENT_HISTORY_COLLECTION)
      .where('ownerId', '==', ownerId)
      .get();

    let payments = [];
    snapshot.forEach(doc => {
      payments.push({ id: doc.id, ...doc.data() });
    });

    // Filter in memory so legacy payments recorded without propertyId still appear.
    if (propertyId) {
      payments = payments.filter((pay) => !pay.propertyId || pay.propertyId === propertyId);
    }
    
    // Sort by paymentDate descending
    payments.sort((a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime());
    
    // Group by tenant
    const byTenant = {};
    payments.forEach(pay => {
      const key = pay.tenantId || pay.tenantEmail;
      if (!byTenant[key]) {
        byTenant[key] = {
          tenantId: pay.tenantId,
          tenantEmail: pay.tenantEmail,
          tenantName: pay.tenantName,
          unit: pay.unit,
          payments: [],
          totalPaid: 0
        };
      }
      byTenant[key].payments.push(pay);
      if (pay.status === 'completed') {
        byTenant[key].totalPaid += pay.amount;
      }
    });
    
    return { 
      ok: true, 
      payments, 
      byTenant: Object.values(byTenant),
      totalCollected: payments.filter(p => p.status === 'completed').reduce((sum, p) => sum + p.amount, 0)
    };
  } catch (error) {
    console.error('[TenantActivity] Error getting payment history:', error);
    return { ok: false, error: error.message || 'Failed to get payment history' };
  }
}

/**
 * Get all activity for a specific tenant (for owner view)
 * @param {string} tenantId
 * @returns {Promise<{ok: boolean, activity?: Object, error?: string}>}
 */
export async function getTenantActivity(tenantId) {
  try {
    // Fetch all types of activity in parallel
    const [messagesSnap, maintenanceSnap, paymentsSnap] = await Promise.all([
      db.collection(TENANT_MESSAGES_COLLECTION).where('tenantId', '==', tenantId).get(),
      db.collection(MAINTENANCE_REQUESTS_COLLECTION).where('tenantId', '==', tenantId).get(),
      db.collection(PAYMENT_HISTORY_COLLECTION).where('tenantId', '==', tenantId).get()
    ]);
    
    const messages = [];
    messagesSnap.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
    
    const maintenanceRequests = [];
    maintenanceSnap.forEach(doc => {
      const request = { id: doc.id, ...doc.data() };
      request.paymentWorkflow = mergeMaintenancePaymentWorkflow(request.paymentWorkflow);
      request.contractorAssignment = mergeContractorAssignment(request.contractorAssignment);
      request.serviceCompletion = mergeServiceCompletion(request.serviceCompletion);
      maintenanceRequests.push(request);
    });
    
    const payments = [];
    paymentsSnap.forEach(doc => payments.push({ id: doc.id, ...doc.data() }));
    
    // Sort all by date
    messages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const visibleMessages = messages.filter((message) => message.tenantVisible !== false);
    maintenanceRequests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    payments.sort((a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime());
    
    return {
      ok: true,
      activity: {
        messages: visibleMessages,
        maintenanceRequests,
        payments,
        summary: {
          totalMessages: visibleMessages.length,
          unreadMessages: visibleMessages.filter(m => m.status === 'unread').length,
          totalMaintenanceRequests: maintenanceRequests.length,
          pendingMaintenance: maintenanceRequests.filter(r => r.status === 'pending').length,
          totalPayments: payments.length,
          totalPaid: payments.filter(p => p.status === 'completed').reduce((sum, p) => sum + p.amount, 0)
        }
      }
    };
  } catch (error) {
    console.error('[TenantActivity] Error getting tenant activity:', error);
    return { ok: false, error: error.message };
  }
}

export async function updateMaintenanceScheduledVisit(requestId, {
  status = undefined,
  scheduledVisit = undefined,
  callOutcome = undefined,
  ownerEmail = undefined
} = {}) {
  try {
    const updateData = {
      updatedAt: new Date().toISOString()
    };

    if (status !== undefined) {
      updateData.status = status;
    }
    if (scheduledVisit !== undefined) {
      updateData.scheduledVisit = scheduledVisit;
    }
    if (callOutcome !== undefined) {
      updateData.callOutcome = callOutcome;
    }
    if (ownerEmail !== undefined) {
      updateData.ownerEmail = ownerEmail;
    }

    await db.collection(MAINTENANCE_REQUESTS_COLLECTION).doc(requestId).update(updateData);
    return { ok: true };
  } catch (error) {
    console.error('[TenantActivity] Error updating scheduled visit:', error);
    return { ok: false, error: error.message };
  }
}

export async function getTenantUpcomingMaintenanceVisits(tenantId) {
  try {
    const snapshot = await db.collection(MAINTENANCE_REQUESTS_COLLECTION)
      .where('tenantId', '==', tenantId)
      .get();

    const now = Date.now();
    const visits = [];

    snapshot.forEach((doc) => {
      const request = { id: doc.id, ...doc.data() };
      const visit = request.scheduledVisit;
      if (!visit?.confirmed || !visit?.startAt) {
        return;
      }
      const startMs = Date.parse(visit.startAt);
      if (Number.isNaN(startMs) || startMs < now - 24 * 60 * 60 * 1000) {
        return;
      }
      visits.push({
        requestId: request.id,
        category: request.category,
        description: request.description,
        propertyAddress: request.propertyAddress,
        unit: request.unit,
        status: request.status,
        scheduledVisit: visit,
        providerName: visit.providerName || request.aiAutomation?.selectedProvider?.name || null
      });
    });

    visits.sort((a, b) => Date.parse(a.scheduledVisit.startAt) - Date.parse(b.scheduledVisit.startAt));
    return { ok: true, visits };
  } catch (error) {
    console.error('[TenantActivity] Error getting upcoming visits:', error);
    return { ok: false, error: error.message, visits: [] };
  }
}

export default {
  saveTenantMessage,
  getOwnerMessages,
  markMessageRead,
  saveMaintenanceRequest,
  getOwnerMaintenanceRequests,
  updateMaintenanceStatus,
  getMaintenanceRequestById,
  updateMaintenanceRequestDetails,
  getAllMaintenanceRequests,
  appendMaintenanceOperatorLog,
  getContractorMaintenanceRequests,
  recordTenantPayment,
  updateTenantPaymentStatus,
  getOwnerPaymentHistory,
  getTenantActivity,
  updateMaintenanceAutomation,
  updateMaintenanceScheduledVisit,
  getTenantUpcomingMaintenanceVisits
};
