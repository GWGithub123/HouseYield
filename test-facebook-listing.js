/**
 * Test Facebook Marketplace Listing
 */

const testListing = {
  title: "Beautiful 2BR Apartment - Downtown",
  property_address: "123 Main St, Seattle, WA 98101",
  monthly_rent: 2500,
  beds: 2,
  baths: 1,
  sqft: 950,
  pets_allowed: true,
  parking_included: true,
  lease_term: "12_month",
  photos: [
    "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800",
    "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800"
  ],
  amenities: ["In-unit laundry", "Hardwood floors", "Modern kitchen"],
  description: "Stunning 2-bedroom apartment in the heart of downtown. Features include modern kitchen with stainless steel appliances, hardwood floors throughout, and in-unit washer/dryer. Pet-friendly building with secure parking."
};

async function testFacebookPost() {
  try {
    console.log('\n🚀 Testing Facebook Marketplace listing...\n');
    console.log('Step 1: Creating listing in database...');
    
    // First create a listing
    const createResponse = await fetch('http://localhost:3001/api/listings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...testListing,
        user_id: 'test-user-' + Date.now(),
        property_id: 'test-property-' + Date.now()
      })
    });
    
    const listing = await createResponse.json();
    
    if (!listing.id) {
      console.log('❌ Failed to create listing');
      console.log('Error:', listing);
      return;
    }
    
    console.log('✅ Listing created with ID:', listing.id);
    console.log('\nStep 2: Syndicating to Facebook Marketplace...');
    
    // Now syndicate to Facebook
    const syndicateResponse = await fetch(`http://localhost:3001/api/listings/${listing.id}/syndicate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        platforms: ['facebook']
      })
    });
    
    const result = await syndicateResponse.json();
    
    console.log('\n=== Syndication Result ===');
    console.log(JSON.stringify(result, null, 2));
    
    if (result.results?.facebook?.success) {
      console.log('\n✅ Successfully posted to Facebook Marketplace!');
      console.log('  Facebook Post ID:', result.results.facebook.externalId);
      console.log('\n🎉 Check your HouseYield Facebook page to see the listing!');
      console.log('   https://www.facebook.com/909347082254241');
    } else {
      console.log('\n❌ Failed to post to Facebook');
      if (result.results?.facebook?.error) {
        console.log('Error:', result.results.facebook.error);
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testFacebookPost();
