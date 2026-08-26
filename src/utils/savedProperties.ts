/**
 * Saved Properties Management
 * Stores property data in localStorage for quick access
 */

import type { PropertyDashboard } from '../types/attom';

export interface SavedProperty {
  id: string; // Unique identifier (attom_id or hash of address)
  address: string;
  savedAt: string; // ISO date string
  data: PropertyDashboard;
  thumbnail?: string; // Future: property image
}

const STORAGE_KEY = 'renaissance_saved_properties';

/**
 * Get all saved properties
 */
export function getSavedProperties(): SavedProperty[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored);
  } catch (err) {
    console.error('Error loading saved properties:', err);
    return [];
  }
}

/**
 * Save a property
 */
export function saveProperty(address: string, data: PropertyDashboard): SavedProperty {
  const properties = getSavedProperties();
  
  // Generate ID from attom_id or hash of address
  const id = data.summary.attom_id || btoa(address).substring(0, 20);
  
  // Check if already saved
  const existingIndex = properties.findIndex(p => p.id === id);
  
  const savedProperty: SavedProperty = {
    id,
    address,
    savedAt: new Date().toISOString(),
    data
  };
  
  if (existingIndex >= 0) {
    // Update existing
    properties[existingIndex] = savedProperty;
  } else {
    // Add new (keep only last 50 properties)
    properties.unshift(savedProperty);
    if (properties.length > 50) {
      properties.pop();
    }
  }
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(properties));
  return savedProperty;
}

/**
 * Remove a saved property
 */
export function removeSavedProperty(id: string): void {
  const properties = getSavedProperties().filter(p => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(properties));
}

/**
 * Check if a property is saved
 */
export function isPropertySaved(address: string, attomId?: string): boolean {
  const properties = getSavedProperties();
  const id = attomId || btoa(address).substring(0, 20);
  return properties.some(p => p.id === id);
}

/**
 * Get a single saved property by ID
 */
export function getSavedProperty(id: string): SavedProperty | null {
  const properties = getSavedProperties();
  return properties.find(p => p.id === id) || null;
}
