/**
 * Property Management Module
 * Handles storing and retrieving user properties with their data
 */

import { getDb } from './connection.js';

/**
 * Save or update a property for a user
 * @param {number} userId - User ID
 * @param {string} address - Property address
 * @param {Object} propertyData - Property dashboard data from ATTOM
 * @param {Object} financials - Financial data entered by user
 * @returns {Object} Property record with id
 */
export function saveProperty(userId, address, propertyData = null, financials = null) {
  const db = getDb();
  
  try {
    // Check if property already exists for this user
    const existingStmt = db.prepare(`
      SELECT id FROM properties WHERE user_id = ? AND address = ?
    `);
    const existing = existingStmt.get(userId, address);
    
    if (existing) {
      // Update existing property
      const updateStmt = db.prepare(`
        UPDATE properties 
        SET property_data = ?, 
            financial_data = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      
      updateStmt.run(
        propertyData ? JSON.stringify(propertyData) : null,
        financials ? JSON.stringify(financials) : null,
        existing.id
      );
      
      console.log('[Properties] Updated property:', address);
      return { id: existing.id, address, updated: true };
    } else {
      // Insert new property
      const insertStmt = db.prepare(`
        INSERT INTO properties (user_id, name, address, property_data, financial_data)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      const result = insertStmt.run(
        userId,
        address, // Use address as name for now
        address,
        propertyData ? JSON.stringify(propertyData) : null,
        financials ? JSON.stringify(financials) : null
      );
      
      console.log('[Properties] Created property:', address, 'with ID:', result.lastInsertRowid);
      return { id: result.lastInsertRowid, address, created: true };
    }
  } catch (e) {
    console.error('[Properties] Error saving property:', e);
    throw e;
  }
}

/**
 * Get all properties for a user
 * @param {number} userId - User ID
 * @returns {Array} List of properties
 */
export function getUserProperties(userId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      SELECT id, name, address, property_data, financial_data, created_at, updated_at
      FROM properties
      WHERE user_id = ?
      ORDER BY updated_at DESC
    `);
    
    const rows = stmt.all(userId);
    
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      address: row.address,
      property_data: row.property_data ? JSON.parse(row.property_data) : null,
      financial_data: row.financial_data ? JSON.parse(row.financial_data) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    }));
  } catch (e) {
    console.error('[Properties] Error getting user properties:', e);
    return [];
  }
}

/**
 * Get a single property by ID
 * @param {number} propertyId - Property ID
 * @param {number} userId - User ID (for security)
 * @returns {Object|null} Property record
 */
export function getProperty(propertyId, userId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      SELECT id, name, address, property_data, financial_data, created_at, updated_at
      FROM properties
      WHERE id = ? AND user_id = ?
    `);
    
    const row = stmt.get(propertyId, userId);
    
    if (!row) return null;
    
    return {
      id: row.id,
      name: row.name,
      address: row.address,
      property_data: row.property_data ? JSON.parse(row.property_data) : null,
      financial_data: row.financial_data ? JSON.parse(row.financial_data) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  } catch (e) {
    console.error('[Properties] Error getting property:', e);
    return null;
  }
}

/**
 * Delete a property
 * @param {number} propertyId - Property ID
 * @param {number} userId - User ID (for security)
 * @returns {boolean} Success status
 */
export function deleteProperty(propertyId, userId) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      DELETE FROM properties WHERE id = ? AND user_id = ?
    `);
    
    const result = stmt.run(propertyId, userId);
    
    console.log('[Properties] Deleted property ID:', propertyId);
    return result.changes > 0;
  } catch (e) {
    console.error('[Properties] Error deleting property:', e);
    return false;
  }
}

/**
 * Update property financial data
 * @param {number} propertyId - Property ID
 * @param {number} userId - User ID (for security)
 * @param {Object} financials - Financial data
 * @returns {boolean} Success status
 */
export function updatePropertyFinancials(propertyId, userId, financials) {
  const db = getDb();
  
  try {
    const stmt = db.prepare(`
      UPDATE properties 
      SET financial_data = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `);
    
    const result = stmt.run(JSON.stringify(financials), propertyId, userId);
    
    console.log('[Properties] Updated financials for property ID:', propertyId);
    return result.changes > 0;
  } catch (e) {
    console.error('[Properties] Error updating financials:', e);
    return false;
  }
}

export default {
  saveProperty,
  getUserProperties,
  getProperty,
  deleteProperty,
  updatePropertyFinancials
};
