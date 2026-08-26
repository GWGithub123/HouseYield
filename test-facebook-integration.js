#!/usr/bin/env node

/**
 * Facebook Marketplace Integration Test Script
 * Tests the Facebook API connection and posts a sample listing
 */

import 'dotenv/config';
import { testFacebookConnection, postToFacebookMarketplace } from './server/facebook-marketplace.js';

console.log('🧪 Facebook Marketplace Integration Test\n');

// Test 1: Check environment variables
console.log('📋 Step 1: Checking environment variables...');
const hasToken = !!process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const hasPageId = !!process.env.FACEBOOK_PAGE_ID;
const hasContactEmail = !!process.env.CONTACT_EMAIL;
const hasContactPhone = !!process.env.CONTACT_PHONE;

console.log(`   FACEBOOK_PAGE_ACCESS_TOKEN: ${hasToken ? '✅ Set' : '❌ Missing'}`);
console.log(`   FACEBOOK_PAGE_ID: ${hasPageId ? '✅ Set' : '❌ Missing'}`);
console.log(`   CONTACT_EMAIL: ${hasContactEmail ? '✅ Set' : '⚠️  Not set'}`);
console.log(`   CONTACT_PHONE: ${hasContactPhone ? '✅ Set' : '⚠️  Not set'}`);

if (!hasToken || !hasPageId) {
  console.log('\n❌ Missing required Facebook credentials!');
  console.log('   Please set FACEBOOK_PAGE_ACCESS_TOKEN and FACEBOOK_PAGE_ID in your .env file');
  console.log('   See FACEBOOK_MARKETPLACE_SETUP.md for instructions');
  process.exit(1);
}

// Test 2: Test API connection
console.log('\n📡 Step 2: Testing Facebook API connection...');
const connectionTest = await testFacebookConnection();

if (!connectionTest.success) {
  console.log(`   ❌ Connection failed: ${connectionTest.error}`);
  console.log('\n💡 Troubleshooting:');
  console.log('   1. Verify your access token is valid and not expired');
  console.log('   2. Ensure your page ID is correct');
  console.log('   3. Check that your app has marketplace_listings permission');
  console.log('   4. See FACEBOOK_MARKETPLACE_SETUP.md for detailed setup');
  process.exit(1);
}

console.log(`   ✅ Connected to page: "${connectionTest.pageName}"`);
console.log(`   Page ID: ${connectionTest.pageId}`);
console.log(`   Marketplace Enabled: ${connectionTest.marketplaceEnabled ? '✅ Yes' : '❌ No'}`);

if (!connectionTest.marketplaceEnabled) {
  console.log('\n   ⚠️  Warning: Marketplace is not enabled on your page');
  console.log('   Go to your page settings and enable the Shop/Marketplace tab');
}

// Test 3: Post a sample listing
console.log('\n📝 Step 3: Posting test listing to Facebook Marketplace...');

const sampleListing = {
  id: 'test-' + Date.now(),
  title: 'TEST LISTING - Beautiful 2BR Apartment',
  description: 'This is a test listing from Renaissance Realty. Modern 2-bedroom apartment with updated kitchen, hardwood floors, and in-unit laundry. Great location near shopping and transit.',
  property_address: '123 Main Street, Washington, DC 20001',
  monthly_rent: 2500,
  security_deposit: 2500,
  beds: 2,
  baths: 2,
  sqft: 1200,
  available_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days from now
  lease_term: '12 months',
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
  photos: [] // No photos for test
};

console.log(`   Listing: ${sampleListing.title}`);
console.log(`   Rent: $${sampleListing.monthly_rent}/month`);
console.log(`   Address: ${sampleListing.property_address}`);

const postResult = await postToFacebookMarketplace(sampleListing);

if (!postResult.success) {
  console.log(`   ❌ Posting failed: ${postResult.error}`);
  
  if (postResult.errorCode === 190) {
    console.log('\n💡 Your access token is invalid or expired');
    console.log('   Generate a new long-lived token following the guide');
  } else if (postResult.errorCode === 100) {
    console.log('\n💡 Check your listing data format');
    console.log('   Some required fields may be missing or invalid');
  }
  
  process.exit(1);
}

console.log(`   ✅ Successfully posted!`);
console.log(`   Facebook ID: ${postResult.externalId}`);
console.log(`   View listing: ${postResult.platformUrl}`);

// Test 4: Instructions for cleanup
console.log('\n🧹 Step 4: Cleanup');
console.log('   ⚠️  This was a TEST listing - please delete it from Facebook Marketplace:');
console.log(`   1. Go to: ${postResult.platformUrl}`);
console.log('   2. Click "Manage listing" → "Delete"');
console.log('   3. Or use the delete API endpoint');

// Summary
console.log('\n✅ All tests passed!');
console.log('\n📋 Summary:');
console.log('   ✓ Environment variables configured');
console.log('   ✓ Facebook API connection working');
console.log('   ✓ Successfully posted test listing');
console.log('   ✓ Your integration is ready to use!');

console.log('\n🚀 Next Steps:');
console.log('   1. Delete the test listing from Facebook');
console.log('   2. Create real listings through the UI or API');
console.log('   3. Start syndicating your vacancies!');

console.log('\n📚 Documentation:');
console.log('   - Setup guide: FACEBOOK_MARKETPLACE_SETUP.md');
console.log('   - API endpoints: See server/index.js');
console.log('   - Test connection: GET /api/facebook/test');
console.log('   - Create listing: POST /api/listings');
console.log('   - Syndicate: POST /api/listings/:id/syndicate');

process.exit(0);
