/**
 * Test script for Federal Reserve Meeting Summary feature
 * 
 * Usage: node server/test-fed-summary.js
 */

import { getFedMeetingSummary } from './fred.js';

async function testFedSummary() {
  console.log('🏦 Testing Federal Reserve Meeting Summary Feature\n');
  console.log('='.repeat(80));
  
  try {
    console.log('\n📊 Fetching Fed meeting summary...\n');
    
    const data = await getFedMeetingSummary();
    
    // Display executive summary
    console.log('📰 EXECUTIVE SUMMARY');
    console.log('='.repeat(80));
    console.log(`\n${data.summary.headline}\n`);
    console.log(`📈 Economic Outlook: ${data.summary.keyTakeaway}`);
    console.log(`🏠 Housing Impact: ${data.summary.housingImpact}`);
    console.log(`💡 Action: ${data.summary.actionableInsight}\n`);
    
    // Display latest meeting info
    if (data.latestMeeting) {
    console.log('\n📋 LATEST FOMC MEETING');
    console.log('='.repeat(80));
    console.log(`Title: ${data.latestMeeting.title}`);
    console.log(`Date: ${data.latestMeeting.date}`);
    console.log(`Link: ${data.latestMeeting.link}`);
    console.log(`Key Topics: ${data.latestMeeting.keyTopics.join(', ')}`);
    console.log(`\nSummary: ${data.latestMeeting.summary.substring(0, 100)}...`);
    
    // Display AI summary if available
    if (data.latestMeeting.aiSummary) {
      console.log('\n🤖 AI SUMMARY - What They Actually Discussed');
      console.log('-'.repeat(80));
      console.log(data.latestMeeting.aiSummary);
    } else {
      console.log('\n⚠️  No AI summary available');
    }
    
    // Display statement excerpt if available
    if (data.latestMeeting.fullText) {
      console.log('\n📄 Statement Excerpt (first 400 chars)');
      console.log('-'.repeat(80));
      console.log(data.latestMeeting.fullText.substring(0, 400) + '...');
    }
    console.log();
    }
    
    // Display key economic indicators
    console.log('📊 KEY ECONOMIC INDICATORS');
    console.log('='.repeat(80));
    console.log('\nInterest Rates:');
    console.log(`  Fed Funds Target: ${data.economicIndicators.interestRates.federalFundsTarget}%`);
    console.log(`  Effective Rate: ${data.economicIndicators.interestRates.federalFundsEffective}%`);
    console.log(`  Trend: ${data.economicIndicators.interestRates.trend.toUpperCase()}`);
    console.log(`  Updated: ${data.economicIndicators.interestRates.date}`);
    
    console.log('\nInflation:');
    console.log(`  CPI: ${data.economicIndicators.inflation.cpi.current} (${data.economicIndicators.inflation.cpi.yoy} YoY)`);
    console.log(`  PCE: ${data.economicIndicators.inflation.pce.current} (${data.economicIndicators.inflation.pce.yoy} YoY)`);
    console.log(`  Trend: ${data.economicIndicators.inflation.cpi.trend.toUpperCase()}`);
    
    console.log('\nEmployment:');
    console.log(`  Unemployment Rate: ${data.economicIndicators.employment.unemploymentRate}%`);
    console.log(`  Trend: ${data.economicIndicators.employment.trend.toUpperCase()}`);
    
    console.log('\nHousing:');
    console.log(`  Mortgage Rate: ${data.economicIndicators.housing.mortgageRate}%`);
    console.log(`  Housing Starts: ${(data.economicIndicators.housing.housingStarts / 1000).toFixed(1)}M`);
    console.log(`  Existing Sales: ${(data.economicIndicators.housing.existingHomeSales / 1000).toFixed(2)}M\n`);
    
    // Display outlook analysis
    console.log('🔮 OUTLOOK ANALYSIS');
    console.log('='.repeat(80));
    
    console.log('\nEconomic Outlook:');
    console.log(`  Overall: ${data.outlook.economy.overall}`);
    console.log(`  Growth: ${data.outlook.economy.growth}`);
    console.log(`  Labor Market: ${data.outlook.economy.laborMarket}`);
    console.log(`  Inflation: ${data.outlook.economy.inflation}`);
    
    console.log('\nInterest Rate Outlook:');
    console.log(`  Current Target: ${data.outlook.interestRates.currentTarget}`);
    console.log(`  Stance: ${data.outlook.interestRates.stance}`);
    console.log(`  Outlook: ${data.outlook.interestRates.outlook}`);
    console.log(`  Next Meeting: ${data.outlook.interestRates.nextMeetingExpectation}`);
    
    console.log('\nHousing Market Outlook:');
    console.log(`  Current Rate: ${data.outlook.housingMarket.mortgageRate.current}`);
    console.log(`  Trend: ${data.outlook.housingMarket.mortgageRate.trend.toUpperCase()}`);
    console.log(`  Impact: ${data.outlook.housingMarket.mortgageRate.impact}`);
    console.log(`  Outlook: ${data.outlook.housingMarket.outlook}`);
    console.log(`  Investor Implications: ${data.outlook.housingMarket.investorImplications}\n`);
    
    // Display recent announcements
    console.log('📢 RECENT ANNOUNCEMENTS');
    console.log('='.repeat(80));
    data.recentAnnouncements.slice(0, 3).forEach((announcement, i) => {
      console.log(`\n${i + 1}. ${announcement.title}`);
      console.log(`   Date: ${announcement.date}`);
      console.log(`   Link: ${announcement.link}`);
    });
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ Test completed successfully!');
    console.log(`Generated at: ${data.generatedAt}`);
    
  } catch (error) {
    console.error('\n❌ Test failed with error:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

// Run test
testFedSummary();
