/**
 * Facebook Marketplace Integration
 * Enhanced integration for posting rental listings to Facebook Marketplace
 */

/**
 * Upload photos to Facebook and get photo IDs
 */
async function uploadPhotosToFacebook(photos, pageId, accessToken) {
  const photoIds = [];
  
  if (!photos || photos.length === 0) {
    console.log('[Facebook] No photos to upload');
    return photoIds;
  }
  
  console.log(`[Facebook] Uploading ${photos.length} photos...`);
  
  for (const photo of photos.slice(0, 10)) { // Facebook allows max 10 photos
    try {
      const photoUrl = photo.url || photo;
      
      const response = await fetch(`https://graph.facebook.com/v18.0/${pageId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: photoUrl,
          published: false, // Don't publish yet, just upload
          access_token: accessToken
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        photoIds.push(data.id);
        console.log(`[Facebook] Uploaded photo: ${data.id}`);
      } else {
        const error = await response.json();
        console.error(`[Facebook] Photo upload failed:`, error);
      }
    } catch (e) {
      console.error('[Facebook] Error uploading photo:', e);
    }
  }
  
  return photoIds;
}

/**
 * Create a rental listing on Facebook Marketplace
 */
export async function postToFacebookMarketplace(listing) {
  const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  
  if (!accessToken || !pageId) {
    return {
      success: false,
      error: 'Facebook API credentials not configured. Set FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_PAGE_ID in .env',
      configured: false
    };
  }
  
  try {
    console.log(`[Facebook] Starting syndication for listing: ${listing.title}`);
    
    // Step 1: Upload photos
    const photoIds = await uploadPhotosToFacebook(listing.photos, pageId, accessToken);
    
    // Step 2: Build listing description
    const description = buildListingDescription(listing);
    
    // Step 3: Build marketplace listing payload
    const payload = {
      availability: 'FOR_RENT',
      listing_type: 'FOR_RENT_BY_OWNER',
      title: listing.title,
      description: description,
      price: Math.round(listing.monthly_rent), // Facebook requires integer
      currency: 'USD',
      location: {
        address: listing.property_address || 'See description'
      },
      marketplace_listing_type: 'homes_for_rent',
      home_listing_attributes: {
        bedrooms: listing.beds || 1,
        bathrooms: listing.baths || 1,
        square_footage: listing.sqft || null,
        pets_allowed: listing.pets_allowed ? 'yes' : 'no',
        parking_type: listing.parking_included ? 'garage' : 'none',
        lease_type: convertLeaseType(listing.lease_term),
        year_built: null, // Could be extracted from property_data
        listing_type: 'apartment', // or 'house', 'condo', etc.
      }
    };
    
    // Add photos if uploaded successfully
    if (photoIds.length > 0) {
      payload.attached_media = photoIds.map(id => ({ media_fbid: id }));
    }
    
    payload.access_token = accessToken;
    
    console.log('[Facebook] Posting to page feed...');
    
    // Step 4: Create page post
    // Note: This posts to your Facebook Page, not Marketplace
    // To access Marketplace, you'll need 20+ properties for Zillow Rental Manager partnership
    const postPayload = {
      message: `${listing.title}\n\n${description}`,
      access_token: accessToken
    };
    
    // Add photos if uploaded successfully
    if (photoIds.length > 0) {
      postPayload.attached_media = photoIds.map(id => ({ media_fbid: id }));
    }
    
    const response = await fetch(`https://graph.facebook.com/v18.0/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postPayload)
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('[Facebook] Marketplace API error:', error);
      
      // Provide helpful error messages
      let errorMessage = error.error?.message || 'Unknown error';
      if (error.error?.code === 190) {
        errorMessage = 'Invalid access token. Please regenerate your Facebook Page Access Token.';
      } else if (error.error?.code === 100) {
        errorMessage = 'Invalid parameters. Check your listing data and try again.';
      }
      
      return {
        success: false,
        error: errorMessage,
        errorCode: error.error?.code,
        errorType: error.error?.type
      };
    }
    
    const data = await response.json();
    
    console.log(`[Facebook] Successfully posted listing: ${data.id}`);
    
    return {
      success: true,
      externalId: data.id,
      platformUrl: `https://www.facebook.com/${data.id}`,
      photoCount: photoIds.length
    };
    
  } catch (error) {
    console.error('[Facebook] Unexpected error:', error);
    return {
      success: false,
      error: error.message || 'Failed to post to Facebook Marketplace'
    };
  }
}

/**
 * Update an existing Facebook Marketplace listing
 */
export async function updateFacebookListing(externalId, updates) {
  const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  
  if (!accessToken) {
    return {
      success: false,
      error: 'Facebook API credentials not configured'
    };
  }
  
  try {
    const payload = {
      access_token: accessToken
    };
    
    if (updates.price) payload.price = Math.round(updates.price);
    if (updates.availability) payload.availability = updates.availability;
    if (updates.description) payload.description = updates.description;
    
    const response = await fetch(`https://graph.facebook.com/v18.0/${externalId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const error = await response.json();
      return {
        success: false,
        error: error.error?.message || 'Update failed'
      };
    }
    
    return { success: true };
    
  } catch (error) {
    console.error('[Facebook] Update error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Delete a Facebook Marketplace listing
 */
export async function deleteFacebookListing(externalId) {
  const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  
  if (!accessToken) {
    return {
      success: false,
      error: 'Facebook API credentials not configured'
    };
  }
  
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${externalId}?access_token=${accessToken}`,
      { method: 'DELETE' }
    );
    
    if (!response.ok) {
      const error = await response.json();
      return {
        success: false,
        error: error.error?.message || 'Delete failed'
      };
    }
    
    return { success: true };
    
  } catch (error) {
    console.error('[Facebook] Delete error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Build formatted listing description
 */
function buildListingDescription(listing) {
  const parts = [];
  
  // Main description
  if (listing.description) {
    parts.push(listing.description);
    parts.push('');
  }
  
  // Property details
  parts.push('🏠 Property Details:');
  if (listing.beds) parts.push(`• ${listing.beds} Bedroom${listing.beds > 1 ? 's' : ''}`);
  if (listing.baths) parts.push(`• ${listing.baths} Bathroom${listing.baths > 1 ? 's' : ''}`);
  if (listing.sqft) parts.push(`• ${listing.sqft.toLocaleString()} sq ft`);
  parts.push('');
  
  // Rental terms
  parts.push('💰 Rental Terms:');
  parts.push(`• Monthly Rent: $${listing.monthly_rent.toLocaleString()}`);
  if (listing.security_deposit) {
    parts.push(`• Security Deposit: $${listing.security_deposit.toLocaleString()}`);
  }
  if (listing.lease_term) parts.push(`• Lease Term: ${listing.lease_term}`);
  if (listing.available_date) {
    parts.push(`• Available: ${new Date(listing.available_date).toLocaleDateString()}`);
  }
  parts.push('');
  
  // Amenities & Features
  const features = [];
  if (listing.pets_allowed) features.push('Pets Allowed 🐕');
  if (listing.parking_included) features.push('Parking Included 🚗');
  if (listing.utilities_included) features.push(`Utilities: ${listing.utilities_included}`);
  
  if (listing.amenities && listing.amenities.length > 0) {
    features.push(...listing.amenities);
  }
  
  if (features.length > 0) {
    parts.push('✨ Amenities & Features:');
    features.forEach(f => parts.push(`• ${f}`));
    parts.push('');
  }
  
  // Contact info
  parts.push('📞 Contact for More Information');
  if (process.env.CONTACT_EMAIL) {
    parts.push(`📧 ${process.env.CONTACT_EMAIL}`);
  }
  if (process.env.CONTACT_PHONE) {
    parts.push(`📱 ${process.env.CONTACT_PHONE}`);
  }
  
  return parts.join('\n');
}

/**
 * Convert lease term to Facebook format
 */
function convertLeaseType(leaseTerm) {
  if (!leaseTerm) return 'long_term';
  
  const term = leaseTerm.toLowerCase();
  if (term.includes('month to month') || term.includes('short')) {
    return 'month_to_month';
  }
  return 'long_term';
}

/**
 * Test Facebook API connection
 */
export async function testFacebookConnection() {
  const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  
  if (!accessToken || !pageId) {
    return {
      success: false,
      error: 'Facebook API credentials not configured'
    };
  }
  
  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${pageId}?fields=name,marketplace_enabled&access_token=${accessToken}`
    );
    
    if (!response.ok) {
      const error = await response.json();
      return {
        success: false,
        error: error.error?.message || 'Connection test failed'
      };
    }
    
    const data = await response.json();
    
    return {
      success: true,
      pageName: data.name,
      marketplaceEnabled: data.marketplace_enabled,
      pageId: pageId
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
