/**
 * Multi-Platform Listing Syndication Service
 * Handles posting to Zillow, Apartments.com, Facebook, Craigslist, etc.
 */

import { postToFacebookMarketplace } from './facebook-marketplace.js';

/**
 * Zillow Rental Manager API Integration
 * https://www.zillow.com/rental-manager/api/docs
 */
export async function syndicateToZillow(listing) {
  const apiKey = process.env.ZILLOW_API_KEY;
  const partnerId = process.env.ZILLOW_PARTNER_ID;
  
  if (!apiKey || !partnerId) {
    throw new Error('Zillow API credentials not configured');
  }
  
  try {
    const payload = {
      address: {
        street: listing.property_address || '',
        city: extractCity(listing.property_address),
        state: extractState(listing.property_address),
        zip: extractZip(listing.property_address)
      },
      listingDetails: {
        price: listing.monthly_rent,
        propertyType: 'RENTAL',
        bedrooms: listing.beds || 0,
        bathrooms: listing.baths || 0,
        squareFeet: listing.sqft,
        availableDate: listing.available_date,
        leaseTerm: listing.lease_term,
        securityDeposit: listing.security_deposit
      },
      description: listing.description || listing.title,
      amenities: {
        petsAllowed: listing.pets_allowed,
        parkingIncluded: listing.parking_included,
        utilitiesIncluded: listing.utilities_included || ''
      },
      photos: (listing.photos || []).map(photo => ({
        url: photo.url || photo,
        caption: photo.caption || ''
      })),
      contactInfo: {
        name: 'Renaissance Realty',
        phone: process.env.CONTACT_PHONE || '',
        email: process.env.CONTACT_EMAIL || ''
      }
    };
    
    const response = await fetch('https://api.zillow.com/listings/v1/rental', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'X-Partner-Id': partnerId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Zillow API error: ${error}`);
    }
    
    const data = await response.json();
    
    return {
      success: true,
      externalId: data.listingId,
      platformUrl: data.listingUrl || `https://www.zillow.com/rental/${data.listingId}`
    };
  } catch (error) {
    console.error('[Syndication] Zillow error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Apartments.com integration removed - requires paid partnership

/**
 * Facebook Marketplace Integration
 * Uses Facebook Graph API for rental listings
 */
export async function syndicateToFacebook(listing) {
  return await postToFacebookMarketplace(listing);
}

/**
 * Craigslist Integration (via email posting service)
 * Note: Craigslist doesn't have official API, this uses email-to-post
 */
export async function syndicateToCraigslist(listing) {
  // Craigslist requires manual posting or paid posting services
  // We'll generate a formatted email that can be sent
  
  const city = extractCity(listing.property_address) || 'washington';
  const state = extractState(listing.property_address) || 'dc';
  
  const emailBody = `
RENTAL LISTING - ${listing.title}

Location: ${listing.property_address}
Rent: $${listing.monthly_rent}/month
Deposit: $${listing.security_deposit || 'Contact for details'}
Beds: ${listing.beds} | Baths: ${listing.baths} | Sq Ft: ${listing.sqft || 'N/A'}
Available: ${listing.available_date || 'Immediate'}
Lease Term: ${listing.lease_term || '12 months'}

${listing.description || ''}

Details:
- Pets: ${listing.pets_allowed ? 'Allowed' : 'Not Allowed'}
- Parking: ${listing.parking_included ? 'Included' : 'Not Included'}
- Utilities: ${listing.utilities_included || 'Tenant Responsible'}

Contact: ${process.env.CONTACT_EMAIL || 'See listing'}
Phone: ${process.env.CONTACT_PHONE || 'See listing'}
  `.trim();
  
  return {
    success: true,
    manual: true,
    instructions: 'Post manually to Craigslist',
    url: `https://${city}.craigslist.org/d/apts-housing-for-rent/search/apa`,
    emailBody,
    note: 'Craigslist requires manual posting or integration with paid posting services like 3taps'
  };
}

/**
 * Trulia Syndication (via Zillow)
 * Trulia is owned by Zillow, so listings syndicate automatically
 */
export async function syndicateToTrulia(listing) {
  // Trulia is owned by Zillow Group
  // Listings posted to Zillow automatically appear on Trulia
  return {
    success: true,
    note: 'Trulia syndication is automatic via Zillow Rental Manager',
    externalId: 'via_zillow',
    platformUrl: null
  };
}

/**
 * HotPads Syndication (via Zillow)
 * HotPads is owned by Zillow, so listings syndicate automatically
 */
export async function syndicateToHotPads(listing) {
  // HotPads is owned by Zillow Group
  // Listings posted to Zillow automatically appear on HotPads
  return {
    success: true,
    note: 'HotPads syndication is automatic via Zillow Rental Manager',
    externalId: 'via_zillow',
    platformUrl: null
  };
}

/**
 * Main syndication function - posts to all platforms
 */
export async function syndicateToAllPlatforms(listing) {
  console.log('[Syndication] Starting multi-platform syndication for listing:', listing.id);
  
  const results = {
    zillow: null,
    facebook: null,
    craigslist: null,
    trulia: null,
    hotpads: null
  };
  
  // Zillow (includes Trulia and HotPads automatically)
  try {
    results.zillow = await syndicateToZillow(listing);
    if (results.zillow.success) {
      results.trulia = await syndicateToTrulia(listing);
      results.hotpads = await syndicateToHotPads(listing);
    }
  } catch (e) {
    console.error('[Syndication] Zillow syndication failed:', e);
    results.zillow = { success: false, error: e.message };
  }
  
  // Facebook Marketplace
  try {
    results.facebook = await syndicateToFacebook(listing);
  } catch (e) {
    console.error('[Syndication] Facebook syndication failed:', e);
    results.facebook = { success: false, error: e.message };
  }
  
  // Craigslist (manual posting instructions)
  try {
    results.craigslist = await syndicateToCraigslist(listing);
  } catch (e) {
    console.error('[Syndication] Craigslist preparation failed:', e);
    results.craigslist = { success: false, error: e.message };
  }
  
  return results;
}

/**
 * Helper function to extract city from address
 */
function extractCity(address) {
  if (!address) return null;
  const parts = address.split(',');
  return parts[parts.length - 2]?.trim();
}

/**
 * Helper function to extract state from address
 */
function extractState(address) {
  if (!address) return null;
  const match = address.match(/\b([A-Z]{2})\b/);
  return match ? match[1] : null;
}

/**
 * Helper function to extract ZIP from address
 */
function extractZip(address) {
  if (!address) return null;
  const match = address.match(/\b(\d{5})\b/);
  return match ? match[1] : null;
}
