#!/usr/bin/env node

/**
 * Direct Facebook Marketplace Post Test
 * Skips connection test and tries to post directly
 */

import 'dotenv/config';
import { postToFacebookMarketplace } from './server/facebook-marketplace.js';

console.log('🧪 Facebook Marketplace Direct Post Test\n');

const sampleListing = {
  id: 'test-' + Date.now(),
  title: 'TEST LISTING - Beautiful 2BR Apartment',
  description: 'This is a test listing from HouseYield. Modern 2-bedroom apartment with updated kitchen, hardwood floors, and in-unit laundry. Great location near shopping and transit.',
  property_address: '123 Main Street, Seattle, WA 98101',
  monthly_rent: 2500,
  security_deposit: 2500,
  beds: 2,
  baths: 2,
  sqft: 1200,
  available_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
  lease_term: '12_month',
  pets_allowed: true,
  parking_included: true,
  utilities_included: 'Heat and Hot Water',
  amenities: [
    'In-unit laundry',
    'Hardwood floors',
    'Updated kitchen',
    'Central air',
    'Dishwasher',
    'Near metro'
  ],
  photos: [
    'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800',
    'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=800'
  ]
};

console.log('📝 Attempting to post listing to Facebook Marketplace...');
console.log(`   Title: ${sampleListing.title}`);
console.log(`   Rent: $${sampleListing.monthly_rent}/month`);
console.log(`   Address: ${sampleListing.property_address}`);
console.log(`   Photos: ${sampleListing.photos.length} photos`);
console.log('');

const postResult = await postToFacebookMarketplace(sampleListing);

console.log('=== Result ===');
console.log(JSON.stringify(postResult, null, 2));

if (postResult.success) {
  console.log('\n🎉 SUCCESS! Listing posted to Facebook Marketplace!');
  console.log(`   Post ID: ${postResult.externalId}`);
  console.log(`   View on Facebook: https://www.facebook.com/${postResult.externalId}`);
  console.log('\n   Check your HouseYield page: https://www.facebook.com/909347082254241');
} else {
  console.log('\n❌ Failed to post listing');
  console.log(`   Error: ${postResult.error}`);
  
  if (postResult.errorCode) {
    console.log(`   Error Code: ${postResult.errorCode}`);
  }
  
  console.log('\n💡 Common issues:');
  console.log('   - Token missing required permissions');
  console.log('   - Marketplace not enabled on your page');
  console.log('   - App not approved for marketplace_listings');
  console.log('   - Token expired (generate a new long-lived token)');
}
