/**
 * Property Firestore Service
 * 
 * Handles Firestore operations for property management:
 * - Property CRUD operations
 * - Property-owner relationships
 * - Tenant associations
 * - Property images
 */

import { initializeFirebaseAdmin, getFirestore } from './firebase-admin.js';

// Initialize Firebase Admin
initializeFirebaseAdmin();
const db = getFirestore();

// Collection references
const PROPERTIES_COLLECTION = 'properties';

/**
 * Save a property to Firestore
 * @param {Object} propertyData
 * @returns {Promise<{ok: boolean, propertyId?: string, error?: string}>}
 */
export async function savePropertyToFirestore({
  ownerId,
  address,
  propertyData = {},
  financials = {},
  tenantId = null,
  image = null
}) {
  try {
    // Generate a deterministic ID from owner + address
    const propertyId = `${ownerId}_${Buffer.from(address).toString('base64').substring(0, 20)}`;
    
    const propertyRef = db.collection(PROPERTIES_COLLECTION).doc(propertyId);
    
    const existingDoc = await propertyRef.get();
    
    const propertyRecord = {
      id: propertyId,
      ownerId,
      address,
      propertyData: propertyData || {},
      financials: financials || {},
      tenantId: tenantId || null,
      image: image || null,
      updatedAt: new Date().toISOString()
    };
    
    if (!existingDoc.exists) {
      propertyRecord.createdAt = new Date().toISOString();
    }
    
    await propertyRef.set(propertyRecord, { merge: true });
    
    // Also update the user's profile properties array (append, not replace)
    try {
      const { FieldValue } = await import('firebase-admin/firestore');
      const userRef = db.collection('users').doc(ownerId);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        await userRef.update({
          properties: FieldValue.arrayUnion(address),
          updatedAt: new Date().toISOString()
        });
        console.log('[PropertyService] Updated user profile properties array for owner:', ownerId);
      }
    } catch (profileError) {
      // Don't fail the save if profile update fails
      console.warn('[PropertyService] Could not update user profile properties array:', profileError.message);
    }
    
    console.log('[PropertyService] Saved property:', address, 'for owner:', ownerId);
    
    return { ok: true, propertyId, property: propertyRecord };
  } catch (error) {
    console.error('[PropertyService] Error saving property:', error);
    return { ok: false, error: error.message || 'Failed to save property' };
  }
}

/**
 * Get all properties for an owner from Firestore
 * @param {string} ownerId
 * @returns {Promise<{ok: boolean, properties?: Array, error?: string}>}
 */
export async function getOwnerProperties(ownerId) {
  try {
    // Simple query without orderBy to avoid index requirement
    const snapshot = await db.collection(PROPERTIES_COLLECTION)
      .where('ownerId', '==', ownerId)
      .get();
    
    const properties = [];
    snapshot.forEach(doc => {
      properties.push({ id: doc.id, ...doc.data() });
    });
    
    // Sort in memory by updatedAt
    properties.sort((a, b) => {
      const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return dateB - dateA;
    });
    
    console.log('[PropertyService] Retrieved', properties.length, 'properties for owner:', ownerId);
    
    return { ok: true, properties };
  } catch (error) {
    console.error('[PropertyService] Error getting owner properties:', error);
    return { ok: false, error: error.message || 'Failed to get properties' };
  }
}

/**
 * Get a single property by ID
 * @param {string} propertyId
 * @returns {Promise<{ok: boolean, property?: Object, error?: string}>}
 */
export async function getPropertyById(propertyId) {
  try {
    const doc = await db.collection(PROPERTIES_COLLECTION).doc(propertyId).get();
    
    if (!doc.exists) {
      return { ok: false, error: 'Property not found' };
    }
    
    return { ok: true, property: { id: doc.id, ...doc.data() } };
  } catch (error) {
    console.error('[PropertyService] Error getting property:', error);
    return { ok: false, error: error.message || 'Failed to get property' };
  }
}

/**
 * Update a property's tenant association
 * Now supports multiple tenants via tenantIds array for multifamily properties
 * @param {string} propertyId
 * @param {string} tenantId
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function linkTenantToProperty(propertyId, tenantId) {
  try {
    const propertyRef = db.collection(PROPERTIES_COLLECTION).doc(propertyId);
    const doc = await propertyRef.get();
    
    if (!doc.exists) {
      console.warn(`[PropertyService] Property ${propertyId} not found - tenant linking will rely on tenant.propertyId field`);
      // Don't fail - the tenant document already has propertyId set
      // getPropertiesWithTenants now queries by tenant.propertyId
      return { ok: true, note: 'Property document not found, but tenant already has propertyId set' };
    }
    
    const propertyData = doc.data();
    
    // Support multiple tenants: maintain tenantIds array
    const existingTenantIds = propertyData.tenantIds || [];
    if (!existingTenantIds.includes(tenantId)) {
      existingTenantIds.push(tenantId);
    }
    
    await propertyRef.update({
      tenantId, // Keep for backward compatibility (primary tenant)
      tenantIds: existingTenantIds, // Array for multifamily support
      updatedAt: new Date().toISOString()
    });
    
    console.log('[PropertyService] Linked tenant', tenantId, 'to property', propertyId, `(${existingTenantIds.length} total tenants)`);
    return { ok: true };
  } catch (error) {
    console.error('[PropertyService] Error linking tenant to property:', error);
    return { ok: false, error: error.message || 'Failed to link tenant' };
  }
}

/**
 * Clear tenant from a property
 * If tenantId provided, removes specific tenant (for multifamily)
 * If no tenantId, clears all tenants from the property
 * @param {string} propertyId
 * @param {string} tenantId - Optional: specific tenant to remove
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function clearTenantFromProperty(propertyId, tenantId = null) {
  try {
    const { FieldValue } = await import('firebase-admin/firestore');
    const TENANTS_COLLECTION = 'tenants';
    
    // If specific tenantId provided, remove just that tenant
    if (tenantId) {
      const propertyRef = db.collection(PROPERTIES_COLLECTION).doc(propertyId);
      const doc = await propertyRef.get();
      
      if (doc.exists) {
        const propertyData = doc.data();
        const tenantIds = propertyData.tenantIds || [];
        const updatedTenantIds = tenantIds.filter(id => id !== tenantId);
        
        const updateData = {
          tenantIds: updatedTenantIds,
          updatedAt: new Date().toISOString()
        };
        
        // If this was the primary tenant, update tenantId field too
        if (propertyData.tenantId === tenantId) {
          updateData.tenantId = updatedTenantIds[0] || FieldValue.delete();
        }
        
        await propertyRef.update(updateData);
      }
      
      // Update tenant document status
      await db.collection(TENANTS_COLLECTION).doc(tenantId).update({
        status: 'inactive',
        removedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      
      console.log('[PropertyService] Cleared tenant', tenantId, 'from property', propertyId);
    } else {
      // Clear all tenants from property
      const propertyRef = db.collection(PROPERTIES_COLLECTION).doc(propertyId);
      const doc = await propertyRef.get();
      
      if (doc.exists) {
        const propertyData = doc.data();
        const tenantIds = propertyData.tenantIds || [];
        if (propertyData.tenantId) tenantIds.push(propertyData.tenantId);
        
        // Mark all tenants as inactive
        const uniqueTenantIds = [...new Set(tenantIds)];
        await Promise.all(uniqueTenantIds.map(tid => 
          db.collection(TENANTS_COLLECTION).doc(tid).update({
            status: 'inactive',
            removedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }).catch(e => console.warn('Could not update tenant', tid, e.message))
        ));
      }
      
      await propertyRef.update({
        tenantId: FieldValue.delete(),
        tenantIds: FieldValue.delete(),
        updatedAt: new Date().toISOString()
      });
      
      console.log('[PropertyService] Cleared all tenants from property', propertyId);
    }
    
    return { ok: true };
  } catch (error) {
    console.error('[PropertyService] Error clearing tenant from property:', error);
    return { ok: false, error: error.message || 'Failed to clear tenant' };
  }
}

/**
 * Update property financials
 * @param {string} propertyId
 * @param {Object} financials
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function updatePropertyFinancials(propertyId, financials) {
  try {
    await db.collection(PROPERTIES_COLLECTION).doc(propertyId).update({
      financials,
      updatedAt: new Date().toISOString()
    });
    
    console.log('[PropertyService] Updated financials for property', propertyId);
    return { ok: true };
  } catch (error) {
    console.error('[PropertyService] Error updating property financials:', error);
    return { ok: false, error: error.message || 'Failed to update financials' };
  }
}

/**
 * Replace the property health / component inventory for a property.
 * @param {string} propertyId
 * @param {string} ownerId
 * @param {Array} healthAssets
 * @returns {Promise<{ok: boolean, healthAssets?: Array, error?: string}>}
 */
export async function updatePropertyHealthAssets(propertyId, ownerId, healthAssets = []) {
  try {
    if (!propertyId || !ownerId) {
      return { ok: false, error: 'propertyId and ownerId are required' };
    }

    const propertyRef = db.collection(PROPERTIES_COLLECTION).doc(propertyId);
    const doc = await propertyRef.get();

    if (!doc.exists) {
      return { ok: false, error: 'Property not found' };
    }

    if (doc.data()?.ownerId !== ownerId) {
      return { ok: false, error: 'Not authorized to update this property' };
    }

    const normalizedAssets = Array.isArray(healthAssets) ? healthAssets : [];
    const updatedAt = new Date().toISOString();

    await propertyRef.update({
      healthAssets: normalizedAssets,
      updatedAt,
    });

    console.log(
      '[PropertyService] Updated health assets for property',
      propertyId,
      `(${normalizedAssets.length} items)`,
    );

    return { ok: true, healthAssets: normalizedAssets, updatedAt };
  } catch (error) {
    console.error('[PropertyService] Error updating property health assets:', error);
    return { ok: false, error: error.message || 'Failed to update property health assets' };
  }
}

/**
 * Delete a property
 * @param {string} propertyId
 * @param {string} ownerId - For verification
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function deletePropertyFromFirestore(propertyId, ownerId) {
  try {
    const doc = await db.collection(PROPERTIES_COLLECTION).doc(propertyId).get();
    
    if (!doc.exists) {
      return { ok: false, error: 'Property not found' };
    }
    
    // Verify ownership
    if (doc.data().ownerId !== ownerId) {
      return { ok: false, error: 'Not authorized to delete this property' };
    }
    
    await db.collection(PROPERTIES_COLLECTION).doc(propertyId).delete();
    
    console.log('[PropertyService] Deleted property', propertyId);
    return { ok: true };
  } catch (error) {
    console.error('[PropertyService] Error deleting property:', error);
    return { ok: false, error: error.message || 'Failed to delete property' };
  }
}

/**
 * Get properties with their associated tenant info
 * Now supports multiple tenants per property (multifamily/units)
 * @param {string} ownerId
 * @returns {Promise<{ok: boolean, properties?: Array, error?: string}>}
 */
export async function getPropertiesWithTenants(ownerId) {
  try {
    // Get all properties for owner
    const propertiesResult = await getOwnerProperties(ownerId);
    
    if (!propertiesResult.ok) {
      return propertiesResult;
    }
    
    const TENANTS_COLLECTION = 'tenants';
    
    // Get ALL tenants for this owner (more efficient than per-property queries)
    const allTenantsSnapshot = await db.collection(TENANTS_COLLECTION)
      .where('ownerId', '==', ownerId)
      .where('status', '==', 'active')
      .get();
    
    // Build a map of propertyId -> tenants array (for multifamily support)
    const tenantsByProperty = {};
    allTenantsSnapshot.forEach(doc => {
      const tenant = { id: doc.id, ...doc.data() };
      const propId = tenant.propertyId;
      if (propId) {
        if (!tenantsByProperty[propId]) {
          tenantsByProperty[propId] = [];
        }
        tenantsByProperty[propId].push(tenant);
      }
    });
    
    // Attach tenants to properties
    const propertiesWithTenants = propertiesResult.properties.map(property => {
      const propertyTenants = tenantsByProperty[property.id] || [];
      
      // For backward compatibility, set 'tenant' to first tenant if exists
      // Also add 'tenants' array for multifamily properties
      if (propertyTenants.length > 0) {
        property.tenant = propertyTenants[0]; // Primary/first tenant
        property.tenants = propertyTenants;   // All tenants (for units)
        property.tenantCount = propertyTenants.length;
      } else if (property.tenantId) {
        // Fallback: Try to fetch by legacy tenantId field
        // This handles properties where tenantId was set directly
        property.tenants = [];
      } else {
        property.tenants = [];
        property.tenantCount = 0;
      }
      
      return property;
    });
    
    // For properties with legacy tenantId but no matched tenants, fetch individually
    const legacyFetches = propertiesWithTenants
      .filter(p => p.tenantId && (!p.tenants || p.tenants.length === 0))
      .map(async (property) => {
        try {
          const tenantDoc = await db.collection(TENANTS_COLLECTION).doc(property.tenantId).get();
          if (tenantDoc.exists) {
            const tenant = { id: tenantDoc.id, ...tenantDoc.data() };
            property.tenant = tenant;
            property.tenants = [tenant];
            property.tenantCount = 1;
          }
        } catch (e) {
          console.warn('[PropertyService] Could not fetch legacy tenant:', property.tenantId);
        }
      });
    
    await Promise.all(legacyFetches);
    
    console.log(`[PropertyService] Retrieved ${propertiesWithTenants.length} properties with tenants for owner: ${ownerId}`);
    
    return { ok: true, properties: propertiesWithTenants };
  } catch (error) {
    console.error('[PropertyService] Error getting properties with tenants:', error);
    return { ok: false, error: error.message || 'Failed to get properties with tenants' };
  }
}
