#!/usr/bin/env node

/**
 * Simple Facebook Page Post Test
 * This will make an API call that Facebook can track for App Review
 */

import 'dotenv/config';

const pageId = process.env.FACEBOOK_PAGE_ID;
const accessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

console.log('🧪 Testing Facebook Page Post API\n');
console.log(`Page ID: ${pageId}`);
console.log(`Token: ${accessToken?.substring(0, 20)}...\n`);

async function testPagePost() {
  try {
    // Test 1: Simple text post to page
    console.log('📝 Test 1: Creating a simple page post...');
    
    const response = await fetch(`https://graph.facebook.com/v18.0/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: '🏠 TEST POST from HouseYield - Property Management Platform\n\nTesting our automated rental listing system. Beautiful 2BR apartment available for rent!\n\nRent: $2,500/month\nBeds: 2 | Baths: 2\nPet-friendly ✓\n\nThis is a test post and will be deleted shortly.',
        access_token: accessToken
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      console.log('❌ Error posting to page:');
      console.log(JSON.stringify(data.error, null, 2));
      return;
    }
    
    console.log('✅ Successfully posted to Facebook page!');
    console.log(`   Post ID: ${data.id}`);
    console.log(`   View at: https://www.facebook.com/${data.id}`);
    
    // Test 2: Get page info
    console.log('\n📊 Test 2: Reading page information...');
    
    const pageResponse = await fetch(`https://graph.facebook.com/v18.0/${pageId}?fields=name,fan_count,category&access_token=${accessToken}`);
    const pageData = await pageResponse.json();
    
    if (pageData.error) {
      console.log('❌ Error reading page info:');
      console.log(JSON.stringify(pageData.error, null, 2));
    } else {
      console.log('✅ Successfully read page data!');
      console.log(`   Page Name: ${pageData.name}`);
      console.log(`   Category: ${pageData.category}`);
      console.log(`   Followers: ${pageData.fan_count || 'N/A'}`);
    }
    
    console.log('\n🎉 Test complete! Facebook should now track these API calls.');
    console.log('⏰ Note: It can take up to 24 hours for test calls to show in App Review.');
    console.log('\n💡 Next steps:');
    console.log('   1. Go to your HouseYield Facebook page and verify the test post appears');
    console.log('   2. Record a screen video showing your app and this test');
    console.log('   3. Return to App Review and upload the video');
    console.log('   4. Wait 24 hours, then check if the API call count updates');
    
  } catch (error) {
    console.error('❌ Unexpected error:', error.message);
  }
}

testPagePost();
