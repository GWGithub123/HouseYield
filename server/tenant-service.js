/**
 * Tenant Service
 * 
 * Handles Firestore operations for tenant management:
 * - Tenant invitations (creating, validating, consuming)
 * - Tenant accounts (registration, linking to properties)
 * - Property-tenant relationships
 */

import { initializeFirebaseAdmin, getFirestore } from './firebase-admin.js';

// Initialize Firebase Admin
initializeFirebaseAdmin();
const db = getFirestore();

// Collection references
const TENANT_INVITES_COLLECTION = 'tenant_invites';
const TENANTS_COLLECTION = 'tenants';

/**
 * Create a new tenant invite in Firestore
 * @param {Object} inviteData
 * @returns {Promise<{ok: boolean, inviteId?: string, error?: string}>}
 */
export async function createTenantInvite({
  token,
  ownerId,
  ownerEmail,
  ownerName,
  propertyId,
  propertyAddress,
  unit,
  tenantEmail,
  tenantName,
  leaseStart,
  leaseEnd,
  monthlyRent,
  expiresAt
}) {
  try {
    const inviteRef = db.collection(TENANT_INVITES_COLLECTION).doc(token);
    
    const inviteData = {
      token,
      ownerId,
      ownerEmail: ownerEmail || '',
      ownerName: ownerName || 'Property Owner',
      propertyId,
      propertyAddress,
      unit: unit || '',
      tenantEmail,
      tenantName: tenantName || 'Tenant',
      leaseStart: leaseStart || null,
      leaseEnd: leaseEnd || null,
      monthlyRent: monthlyRent || null,
      expiresAt: new Date(expiresAt),
      used: false,
      usedAt: null,
      createdAt: new Date(),
      status: 'pending' // pending, used, expired
    };

    await inviteRef.set(inviteData);
    
    console.log(`[TenantService] ✅ Created invite for ${tenantEmail} at ${propertyAddress}`);
    
    return { ok: true, inviteId: token };
  } catch (error) {
    console.error('[TenantService] Error creating invite:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get a tenant invite by token
 * @param {string} token
 * @returns {Promise<{ok: boolean, invite?: Object, error?: string}>}
 */
export async function getTenantInvite(token) {
  try {
    const inviteRef = db.collection(TENANT_INVITES_COLLECTION).doc(token);
    const doc = await inviteRef.get();

    if (!doc.exists) {
      return { ok: false, error: 'Invalid invite link' };
    }

    const invite = doc.data();

    // Check if already used
    if (invite.used) {
      return { ok: false, error: 'This invite has already been used' };
    }

    // Check expiration
    const expiresAt = invite.expiresAt?.toDate?.() || new Date(invite.expiresAt);
    if (new Date() > expiresAt) {
      // Mark as expired
      await inviteRef.update({ status: 'expired' });
      return { ok: false, error: 'This invite link has expired' };
    }

    return {
      ok: true,
      invite: {
        ...invite,
        expiresAt: expiresAt.toISOString(),
        createdAt: invite.createdAt?.toDate?.()?.toISOString() || invite.createdAt
      }
    };
  } catch (error) {
    console.error('[TenantService] Error getting invite:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Mark an invite as used and create tenant record
 * @param {string} token
 * @param {Object} tenantData
 * @returns {Promise<{ok: boolean, tenantId?: string, error?: string}>}
 */
export async function consumeInviteAndCreateTenant(token, tenantData) {
  try {
    const inviteRef = db.collection(TENANT_INVITES_COLLECTION).doc(token);
    const inviteDoc = await inviteRef.get();

    if (!inviteDoc.exists) {
      return { ok: false, error: 'Invalid invite' };
    }

    const invite = inviteDoc.data();

    if (invite.used) {
      return { ok: false, error: 'Invite already used' };
    }

    // Create tenant document
    const tenantId = `tenant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tenantRef = db.collection(TENANTS_COLLECTION).doc(tenantId);

    const tenant = {
      id: tenantId,
      firebaseUid: tenantData.firebaseUid || null,
      email: tenantData.email || invite.tenantEmail,
      name: tenantData.name || invite.tenantName,
      phone: tenantData.phone || '',
      photoURL: tenantData.photoURL || null, // Profile photo from Google or custom upload
      
      // Property linkage (critical for isolation)
      ownerId: invite.ownerId,
      propertyId: invite.propertyId,
      propertyAddress: invite.propertyAddress,
      unit: invite.unit || '',
      
      // Lease info
      leaseStart: invite.leaseStart || null,
      leaseEnd: invite.leaseEnd || null,
      monthlyRent: invite.monthlyRent || null,
      
      // Status
      status: 'active',
      inviteToken: token,
      
      // Timestamps
      createdAt: new Date(),
      registeredAt: new Date(),
      lastLoginAt: null
    };

    // Use batch write for atomicity
    const batch = db.batch();
    
    // Create tenant
    batch.set(tenantRef, tenant);
    
    // Mark invite as used
    batch.update(inviteRef, {
      used: true,
      usedAt: new Date(),
      status: 'used',
      tenantId
    });

    await batch.commit();

    console.log(`[TenantService] ✅ Created tenant ${tenantId} and consumed invite ${token}`);

    return { ok: true, tenantId, tenant };
  } catch (error) {
    console.error('[TenantService] Error consuming invite:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get tenant by Firebase UID
 * @param {string} firebaseUid
 * @returns {Promise<{ok: boolean, tenant?: Object, error?: string}>}
 */
export async function getTenantByFirebaseUid(firebaseUid) {
  try {
    const snapshot = await db.collection(TENANTS_COLLECTION)
      .where('firebaseUid', '==', firebaseUid)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return { ok: false, error: 'Tenant not found' };
    }

    const tenant = snapshot.docs[0].data();
    return { ok: true, tenant };
  } catch (error) {
    console.error('[TenantService] Error getting tenant:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Get all tenants for a property owner
 * @param {string} ownerId
 * @param {string} propertyId - Optional, filter by specific property
 * @returns {Promise<{ok: boolean, tenants?: Array, error?: string}>}
 */
export async function getTenantsByOwner(ownerId, propertyId = null) {
  try {
    // Simple query without orderBy to avoid needing composite index
    let query = db.collection(TENANTS_COLLECTION)
      .where('ownerId', '==', ownerId);

    if (propertyId) {
      query = db.collection(TENANTS_COLLECTION)
        .where('ownerId', '==', ownerId)
        .where('propertyId', '==', propertyId);
    }

    const snapshot = await query.get();
    
    const tenants = snapshot.docs.map(doc => ({
      ...doc.data(),
      id: doc.id,
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString(),
      registeredAt: doc.data().registeredAt?.toDate?.()?.toISOString(),
      lastLoginAt: doc.data().lastLoginAt?.toDate?.()?.toISOString()
    }));
    
    // Sort client-side instead
    tenants.sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    });

    return { ok: true, tenants };
  } catch (error) {
    console.error('[TenantService] Error getting tenants:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Update tenant's last login time
 * @param {string} tenantId
 */
export async function updateTenantLastLogin(tenantId) {
  try {
    await db.collection(TENANTS_COLLECTION).doc(tenantId).update({
      lastLoginAt: new Date()
    });
  } catch (error) {
    console.error('[TenantService] Error updating last login:', error);
  }
}

/**
 * Get pending invites for a property owner
 * @param {string} ownerId
 * @returns {Promise<{ok: boolean, invites?: Array, error?: string}>}
 */
export async function getPendingInvites(ownerId) {
  try {
    const snapshot = await db.collection(TENANT_INVITES_COLLECTION)
      .where('ownerId', '==', ownerId)
      .where('status', '==', 'pending')
      .orderBy('createdAt', 'desc')
      .get();

    const invites = snapshot.docs.map(doc => ({
      ...doc.data(),
      expiresAt: doc.data().expiresAt?.toDate?.()?.toISOString(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString()
    }));

    return { ok: true, invites };
  } catch (error) {
    console.error('[TenantService] Error getting pending invites:', error);
    return { ok: false, error: error.message };
  }
}

/**
 * Update tenant unit number
 */
export async function updateTenantUnit(tenantId, unit) {
  try {
    const tenantRef = db.collection(TENANTS_COLLECTION).doc(tenantId);
    const doc = await tenantRef.get();
    
    if (!doc.exists) {
      return { ok: false, error: 'Tenant not found' };
    }
    
    await tenantRef.update({
      unit: unit,
      updatedAt: new Date()
    });
    
    console.log(`[TenantService] Updated unit for tenant ${tenantId} to "${unit}"`);
    return { ok: true };
  } catch (error) {
    console.error('[TenantService] Error updating tenant unit:', error);
    return { ok: false, error: error.message };
  }
}

export default {
  createTenantInvite,
  getTenantInvite,
  consumeInviteAndCreateTenant,
  getTenantByFirebaseUid,
  getTenantsByOwner,
  updateTenantLastLogin,
  getPendingInvites,
  updateTenantUnit
};
