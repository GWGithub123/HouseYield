// Quick script to get Facebook Page ID
const accessToken = 'EAAKfoaHDr7IBP4EFNZBCIeSgDi4a57xtjZBiRDj5UxLGkFVT9KFCJzSf7ZBxpTuldICH8Mk2TNS1UthtSrjQZAliZCFl0wxG2uwui9Ke2tZA8u9AZAfO3AruJNavRv4o0iHoPGrca5RlU0YfKDaOsoFgT2B7B8y0rlPXCA5V67BXTKhiqfZCFlo64kBY2ZB62PPfFR33Vmd5QJbEpLg5hw4Bb7cTvopPMrds86kKhPcWhsTfn0YmC5hjJFzhmOPZBbyOTv7jKCohqfMKYYMvhlKAYNhyTH';

async function getPageInfo() {
  try {
    // First, get list of pages you manage
    console.log('\n🔍 Fetching your Facebook Pages...\n');
    const response = await fetch(`https://graph.facebook.com/v18.0/me/accounts?access_token=${accessToken}`);
    const data = await response.json();
    
    if (data.error) {
      console.error('❌ Error:', data.error.message);
      console.error('Error Code:', data.error.code);
      return;
    }
    
    if (!data.data || data.data.length === 0) {
      console.log('❌ No pages found. Make sure you have a Facebook Page created.');
      return;
    }
    
    console.log('=== Your Facebook Pages ===\n');
    
    data.data.forEach((page, index) => {
      console.log(`Page ${index + 1}:`);
      console.log(`  Name: ${page.name}`);
      console.log(`  ID: ${page.id}`);
      console.log(`  Access Token: ${page.access_token}`);
      console.log('');
    });
    
    // Use the first page
    const firstPage = data.data[0];
    console.log('\n✅ Using first page for .env configuration:\n');
    console.log('Add these to your .env file:');
    console.log(`FACEBOOK_PAGE_ID=${firstPage.id}`);
    console.log(`FACEBOOK_PAGE_ACCESS_TOKEN=${firstPage.access_token}`);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

getPageInfo();
