/**
 * Property Data Cache Module
 * Manages caching of ATTOM API property data to reduce redundant API calls
 */

import { getDb } from './connection.js';

/**
 * Normalize address for consistent cache lookups
 * Converts to uppercase, removes extra spaces, normalizes common abbreviations
 */
function normalizeAddress(address) {
  if (!address) return '';
  
  return address
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bSTREET\b/g, 'ST')
    .replace(/\bAVENUE\b/g, 'AVE')
    .replace(/\bBOULEVARD\b/g, 'BLVD')
    .replace(/\bROAD\b/g, 'RD')
    .replace(/\bDRIVE\b/g, 'DR')
    .replace(/\bLANE\b/g, 'LN')
    .replace(/\bCOURT\b/g, 'CT')
    .replace(/\bAPARTMENT\b/g, 'APT')
    .replace(/\bSUITE\b/g, 'STE');
}

/**
 * Get cached property data by address
 * @param {string} address - Property address
 * @returns {Object|null} Cached property data or null if not found/expired
 */
export function getCachedPropertyData(address) {
  if (!address) return null;
  
  const db = getDb();
  const normalizedAddress = normalizeAddress(address);
  
  // Cache TTL: 30 days (property data doesn't change frequently)
  const cacheTTL = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
  const expirationDate = new Date(Date.now() - cacheTTL).toISOString();
  
  const stmt = db.prepare(`
    SELECT property_data, last_fetched_at, attom_id
    FROM property_data_cache
    WHERE normalized_address = ?
    AND last_fetched_at > ?
  `);
  
  const row = stmt.get(normalizedAddress, expirationDate);
  
  if (row) {
    console.log('[PropertyCache] Cache HIT for:', address);
    try {
      return {
        data: JSON.parse(row.property_data),
        cached_at: row.last_fetched_at,
        attom_id: row.attom_id
      };
    } catch (e) {
      console.error('[PropertyCache] Failed to parse cached data:', e);
      return null;
    }
  }
  
  console.log('[PropertyCache] Cache MISS for:', address);
  return null;
}

/**
 * Save property data to cache
 * @param {string} address - Original property address
 * @param {Object} propertyData - Property data object from ATTOM API
 * @returns {boolean} Success status
 */
export function cachePropertyData(address, propertyData) {
  if (!address || !propertyData) return false;
  
  const db = getDb();
  const normalizedAddress = normalizeAddress(address);
  const attomId = propertyData.summary?.attom_id || null;
  
  try {
    const stmt = db.prepare(`
      INSERT INTO property_data_cache (address, normalized_address, attom_id, property_data, last_fetched_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(normalized_address) DO UPDATE SET
        address = excluded.address,
        attom_id = excluded.attom_id,
        property_data = excluded.property_data,
        last_fetched_at = CURRENT_TIMESTAMP
    `);
    
    stmt.run(address, normalizedAddress, attomId, JSON.stringify(propertyData));
    console.log('[PropertyCache] Cached data for:', address);
    return true;
  } catch (e) {
    console.error('[PropertyCache] Failed to cache data:', e);
    return false;
  }
}

/**
 * Get cached property data by ATTOM ID
 * @param {string} attomId - ATTOM property ID
 * @returns {Object|null} Cached property data or null if not found/expired
 */
export function getCachedPropertyDataById(attomId) {
  if (!attomId) return null;
  
  const db = getDb();
  
  // Cache TTL: 30 days
  const cacheTTL = 30 * 24 * 60 * 60 * 1000;
  const expirationDate = new Date(Date.now() - cacheTTL).toISOString();
  
  const stmt = db.prepare(`
    SELECT property_data, last_fetched_at, address
    FROM property_data_cache
    WHERE attom_id = ?
    AND last_fetched_at > ?
  `);
  
  const row = stmt.get(attomId, expirationDate);
  
  if (row) {
    console.log('[PropertyCache] Cache HIT by ID:', attomId);
    try {
      return {
        data: JSON.parse(row.property_data),
        cached_at: row.last_fetched_at,
        address: row.address
      };
    } catch (e) {
      console.error('[PropertyCache] Failed to parse cached data:', e);
      return null;
    }
  }
  
  console.log('[PropertyCache] Cache MISS by ID:', attomId);
  return null;
}

/**
 * Clear expired cache entries
 * @param {number} daysOld - Remove entries older than this many days (default 30)
 * @returns {number} Number of entries removed
 */
export function clearExpiredCache(daysOld = 30) {
  const db = getDb();
  const cacheTTL = daysOld * 24 * 60 * 60 * 1000;
  const expirationDate = new Date(Date.now() - cacheTTL).toISOString();
  
  const stmt = db.prepare(`
    DELETE FROM property_data_cache
    WHERE last_fetched_at < ?
  `);
  
  const result = stmt.run(expirationDate);
  console.log(`[PropertyCache] Cleared ${result.changes} expired cache entries`);
  return result.changes;
}

/**
 * Get cache statistics
 * @returns {Object} Cache statistics
 */
export function getCacheStats() {
  const db = getDb();
  
  const totalStmt = db.prepare('SELECT COUNT(*) as total FROM property_data_cache');
  const total = totalStmt.get().total;
  
  const cacheTTL = 30 * 24 * 60 * 60 * 1000;
  const expirationDate = new Date(Date.now() - cacheTTL).toISOString();
  
  const validStmt = db.prepare(`
    SELECT COUNT(*) as valid FROM property_data_cache WHERE last_fetched_at > ?
  `);
  const valid = validStmt.get(expirationDate).valid;
  
  return {
    total_entries: total,
    valid_entries: valid,
    expired_entries: total - valid
  };
}

export default {
  getCachedPropertyData,
  cachePropertyData,
  getCachedPropertyDataById,
  clearExpiredCache,
  getCacheStats,
  normalizeAddress
};
