/**
 * Property Listings Management Module
 * Handles vacancy listings, syndication, and lead tracking
 */

import { getDb } from './connection.js';

/**
 * Create a new property listing
 */
export function createListing(userId, listingData) {
  const db = getDb();
  
  try {
    // First, ensure we have a property_id. If not provided, create a basic property entry
    let propertyId = listingData.property_id;
    
    if (!propertyId && listingData.property_address) {
      // Create a basic property entry for this listing
      const propStmt = db.prepare(`
        INSERT INTO properties (user_id, name, address)
        VALUES (?, ?, ?)
      `);
      const propResult = propStmt.run(
        userId,
        listingData.property_address,
        listingData.property_address
      );
      propertyId = propResult.lastInsertRowid;
      console.log('[Listings] Created property ID:', propertyId);
    }
    
    const stmt = db.prepare(`
      INSERT INTO property_listings (
        property_id, user_id, title, description, monthly_rent, security_deposit,
        beds, baths, sqft, available_date, lease_term, pets_allowed, parking_included,
        utilities_included, amenities, photos, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      propertyId,
      userId,
      listingData.title,
      listingData.description || null,
      listingData.monthly_rent,
      listingData.security_deposit || null,
      listingData.beds || null,
      listingData.baths || null,
      listingData.sqft || null,
      listingData.available_date || null,
      listingData.lease_term || '12 months',
      listingData.pets_allowed ? 1 : 0,
      listingData.parking_included ? 1 : 0,
      listingData.utilities_included || null,
      listingData.amenities ? JSON.stringify(listingData.amenities) : null,
      listingData.photos ? JSON.stringify(listingData.photos) : null,
      listingData.status || 'draft'
    );
    
    console.log('[Listings] Created listing ID:', result.lastInsertRowid);
    return getListingById(result.lastInsertRowid, userId);
  } catch (e) {
    console.error('[Listings] Error creating listing:', e);
    throw e;
  }
}

/**
 * Get all listings for a user
 */
export function getUserListings(userId, filters = {}) {
  const db = getDb();
  
  try {
    let query = `
      SELECT l.*, p.address as property_address, p.property_data
      FROM property_listings l
      LEFT JOIN properties p ON l.property_id = p.id
      WHERE l.user_id = ?
    `;
    
    const params = [userId];
    
    if (filters.status) {
      query += ' AND l.status = ?';
      params.push(filters.status);
    }
    
    query += ' ORDER BY l.created_at DESC';
    
    const stmt = db.prepare(query);
    const rows = stmt.all(...params);
    
    return rows.map(row => ({
      id: row.id,
      property_id: row.property_id,
      property_address: row.property_address,
      title: row.title,
      description: row.description,
      monthly_rent: row.monthly_rent,
      security_deposit: row.security_deposit,
      beds: row.beds,
      baths: row.baths,
      sqft: row.sqft,
      available_date: row.available_date,
      lease_term: row.lease_term,
      pets_allowed: row.pets_allowed === 1,
      parking_included: row.parking_included === 1,
      utilities_included: row.utilities_included,
      amenities: row.amenities ? JSON.parse(row.amenities) : null,
      photos: row.photos ? JSON.parse(row.photos) : null,
      status: row.status,
      views_count: row.views_count,
      leads_count: row.leads_count,
      property_data: row.property_data ? JSON.parse(row.property_data) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));
  } catch (e) {
    console.error('[Listings] Error getting user listings:', e);
    return [];
  }
}

/**
 * Get a single listing by ID
 */
export function getListingById(listingId, userId = null) {
  const db = getDb();
  
  try {
    let query = `
      SELECT l.*, p.address as property_address, p.property_data
      FROM property_listings l
      LEFT JOIN properties p ON l.property_id = p.id
      WHERE l.id = ?
    `;
    
    const params = [listingId];
    
    if (userId) {
      query += ' AND l.user_id = ?';
      params.push(userId);
    }
    
    const stmt = db.prepare(query);
    const row = stmt.get(...params);
    
    if (!row) return null;
    
    return {
      id: row.id,
      property_id: row.property_id,
      user_id: row.user_id,
      property_address: row.property_address,
      title: row.title,
      description: row.description,
      monthly_rent: row.monthly_rent,
      security_deposit: row.security_deposit,
      beds: row.beds,
      baths: row.baths,
      sqft: row.sqft,
      available_date: row.available_date,
      lease_term: row.lease_term,
      pets_allowed: row.pets_allowed === 1,
      parking_included: row.parking_included === 1,
      utilities_included: row.utilities_included,
      amenities: row.amenities ? JSON.parse(row.amenities) : null,
      photos: row.photos ? JSON.parse(row.photos) : null,
      status: row.status,
      views_count: row.views_count,
      leads_count: row.leads_count,
      property_data: row.property_data ? JSON.parse(row.property_data) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  } catch (e) {
    console.error('[Listings] Error getting listing:', e);
    return null;
  }
}

/**
 * Update a listing
 */
export function updateListing(listingId, userId, updates) {
  const db = getDb();
  
  try {
    const allowedFields = [
      'title', 'description', 'monthly_rent', 'security_deposit',
      'beds', 'baths', 'sqft', 'available_date', 'lease_term',
      'pets_allowed', 'parking_included', 'utilities_included',
      'amenities', 'photos', 'status'
    ];
    
    const setClauses = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        setClauses.push(`${key} = ?`);
        if (key === 'amenities' || key === 'photos') {
          values.push(value ? JSON.stringify(value) : null);
        } else if (key === 'pets_allowed' || key === 'parking_included') {
          values.push(value ? 1 : 0);
        } else {
          values.push(value);
        }
      }
    }
    
    if (setClauses.length === 0) {
      throw new Error('No valid fields to update');
    }
    
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    
    const query = `
      UPDATE property_listings
      SET ${setClauses.join(', ')}
      WHERE id = ? AND user_id = ?
    `;
    
    values.push(listingId, userId);
    
    const stmt = db.prepare(query);
    const result = stmt.run(...values);
    
    if (result.changes === 0) {
      throw new Error('Listing not found or unauthorized');
    }
    
    console.log('[Listings] Updated listing ID:', listingId);
    return getListingById(listingId, userId);
  } catch (e) {
    console.error('[Listings] Error updating listing:', e);
    throw e;
  }
}

/**
 * Delete a listing
 */
export function deleteListing(listingId, userId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare('DELETE FROM property_listings WHERE id = ? AND user_id = ?');
    const result = stmt.run(listingId, userId);
    
    console.log('[Listings] Deleted listing ID:', listingId);
    return result.changes > 0;
  } catch (e) {
    console.error('[Listings] Error deleting listing:', e);
    return false;
  }
}

/**
 * Increment view count for a listing
 */
export function incrementListingViews(listingId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare('UPDATE property_listings SET views_count = views_count + 1 WHERE id = ?');
    stmt.run(listingId);
  } catch (e) {
    console.error('[Listings] Error incrementing views:', e);
  }
}

/**
 * Create or update syndication record
 */
export function createSyndication(listingId, platform, externalId = null, platformUrl = null) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      INSERT INTO listing_syndication (listing_id, platform, external_id, status, posted_at, platform_url)
      VALUES (?, ?, ?, 'posted', CURRENT_TIMESTAMP, ?)
      ON CONFLICT(listing_id, platform) 
      DO UPDATE SET 
        external_id = excluded.external_id,
        status = 'active',
        posted_at = CURRENT_TIMESTAMP,
        platform_url = excluded.platform_url,
        last_synced_at = CURRENT_TIMESTAMP,
        error_message = NULL
    `);
    
    stmt.run(listingId, platform, externalId, platformUrl);
    console.log(`[Listings] Syndicated to ${platform} for listing ID:`, listingId);
    return true;
  } catch (e) {
    console.error('[Listings] Error creating syndication:', e);
    return false;
  }
}

/**
 * Update syndication status
 */
export function updateSyndicationStatus(listingId, platform, status, errorMessage = null) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      UPDATE listing_syndication
      SET status = ?, error_message = ?, last_synced_at = CURRENT_TIMESTAMP
      WHERE listing_id = ? AND platform = ?
    `);
    
    stmt.run(status, errorMessage, listingId, platform);
    return true;
  } catch (e) {
    console.error('[Listings] Error updating syndication status:', e);
    return false;
  }
}

/**
 * Get syndication status for a listing
 */
export function getListingSyndication(listingId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare('SELECT * FROM listing_syndication WHERE listing_id = ?');
    return stmt.all(listingId);
  } catch (e) {
    console.error('[Listings] Error getting syndication:', e);
    return [];
  }
}

/**
 * Create a lead from an inquiry
 */
export function createLead(listingId, leadData) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      INSERT INTO tenant_leads (
        listing_id, name, email, phone, message, move_in_date,
        household_size, pets, employment_status, source, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
    `);
    
    const result = stmt.run(
      listingId,
      leadData.name,
      leadData.email,
      leadData.phone || null,
      leadData.message || null,
      leadData.move_in_date || null,
      leadData.household_size || null,
      leadData.pets ? 1 : 0,
      leadData.employment_status || null,
      leadData.source || 'website'
    );
    
    // Increment leads count on listing
    const updateStmt = db.prepare('UPDATE property_listings SET leads_count = leads_count + 1 WHERE id = ?');
    updateStmt.run(listingId);
    
    console.log('[Listings] Created lead ID:', result.lastInsertRowid);
    return getLeadById(result.lastInsertRowid);
  } catch (e) {
    console.error('[Listings] Error creating lead:', e);
    throw e;
  }
}

/**
 * Get all leads for a listing
 */
export function getListingLeads(listingId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      SELECT * FROM tenant_leads
      WHERE listing_id = ?
      ORDER BY created_at DESC
    `);
    
    const rows = stmt.all(listingId);
    return rows.map(row => ({
      ...row,
      pets: row.pets === 1
    }));
  } catch (e) {
    console.error('[Listings] Error getting leads:', e);
    return [];
  }
}

/**
 * Get a single lead by ID
 */
export function getLeadById(leadId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare('SELECT * FROM tenant_leads WHERE id = ?');
    const row = stmt.get(leadId);
    
    if (!row) return null;
    
    return {
      ...row,
      pets: row.pets === 1
    };
  } catch (e) {
    console.error('[Listings] Error getting lead:', e);
    return null;
  }
}

/**
 * Update lead status
 */
export function updateLeadStatus(leadId, status, notes = null) {
  const db = getDb();
  
  try {
    let query = 'UPDATE tenant_leads SET status = ?, updated_at = CURRENT_TIMESTAMP';
    const params = [status];
    
    if (status === 'contacted') {
      query += ', contacted_at = CURRENT_TIMESTAMP';
    }
    
    if (notes) {
      query += ', notes = ?';
      params.push(notes);
    }
    
    query += ' WHERE id = ?';
    params.push(leadId);
    
    const stmt = db.prepare(query);
    stmt.run(...params);
    
    console.log('[Listings] Updated lead status:', leadId, status);
    return true;
  } catch (e) {
    console.error('[Listings] Error updating lead status:', e);
    return false;
  }
}

/**
 * Create a showing request
 */
export function createShowingRequest(listingId, leadId, requestedDate, requestedTime) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      INSERT INTO showing_requests (listing_id, lead_id, requested_date, requested_time, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);
    
    const result = stmt.run(listingId, leadId, requestedDate, requestedTime);
    console.log('[Listings] Created showing request ID:', result.lastInsertRowid);
    return result.lastInsertRowid;
  } catch (e) {
    console.error('[Listings] Error creating showing request:', e);
    throw e;
  }
}

/**
 * Get showing requests for a listing
 */
export function getListingShowings(listingId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      SELECT s.*, l.name as lead_name, l.email as lead_email, l.phone as lead_phone
      FROM showing_requests s
      LEFT JOIN tenant_leads l ON s.lead_id = l.id
      WHERE s.listing_id = ?
      ORDER BY s.requested_date ASC, s.requested_time ASC
    `);
    
    return stmt.all(listingId);
  } catch (e) {
    console.error('[Listings] Error getting showings:', e);
    return [];
  }
}

/**
 * Update showing status
 */
export function updateShowingStatus(showingId, status) {
  const db = getDb();
  
  try {
    let query = 'UPDATE showing_requests SET status = ?';
    const params = [status];
    
    if (status === 'confirmed') {
      query += ', confirmed_at = CURRENT_TIMESTAMP';
    } else if (status === 'completed') {
      query += ', completed_at = CURRENT_TIMESTAMP';
    }
    
    query += ' WHERE id = ?';
    params.push(showingId);
    
    const stmt = db.prepare(query);
    stmt.run(...params);
    
    console.log('[Listings] Updated showing status:', showingId, status);
    return true;
  } catch (e) {
    console.error('[Listings] Error updating showing status:', e);
    return false;
  }
}
