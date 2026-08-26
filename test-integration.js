import 'dotenv/config';
import { fetchPropertyDashboard } from './server/attom.js';

const testAddress = '11822 Prestwick Rd, Potomac MD, 20854';

console.log('\n=== Testing ATTOM + Mortgage Rate Integration ===\n');
console.log('Address:', testAddress);

try {
  const dashboard = await fetchPropertyDashboard({ address: testAddress });
  
  console.log('\n--- Property Summary ---');
  console.log('Address:', dashboard.summary.address);
  console.log('Year Built:', dashboard.summary.year_built);
  console.log('Beds/Baths:', dashboard.summary.beds, '/', dashboard.summary.baths);
  console.log('Living Sq Ft:', dashboard.summary.living_sqft?.toLocaleString());
  console.log('AVM Value:', dashboard.summary.avm_value ? '$' + dashboard.summary.avm_value.toLocaleString() : 'N/A');
  
  if (dashboard.summary.mortgage) {
    console.log('\n--- Mortgage Information ---');
    console.log('Lender:', dashboard.summary.mortgage.lender_name);
    console.log('Loan Amount:', '$' + dashboard.summary.mortgage.amount.toLocaleString());
    console.log('Loan Date:', dashboard.summary.mortgage.date);
    console.log('Loan Type:', dashboard.summary.mortgage.loan_type);
    console.log('Term:', dashboard.summary.mortgage.term_months / 12, 'years');
    console.log('Due Date:', dashboard.summary.mortgage.due_date);
    
    if (dashboard.summary.mortgage.estimated_interest_rate) {
      console.log('\n💡 ESTIMATED RATE:', dashboard.summary.mortgage.estimated_interest_rate + '%');
      console.log('   (Based on FRED historical data for', dashboard.summary.mortgage.date + ')');
      console.log('\n📊 Payment Breakdown:');
      console.log('   Monthly Payment (P&I):', '$' + dashboard.summary.mortgage.estimated_monthly_payment_pi.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      
      if (dashboard.summary.mortgage.payment_breakdown) {
        const breakdown = dashboard.summary.mortgage.payment_breakdown;
        console.log('   Property Tax:', '$' + breakdown.property_tax.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        console.log('   ─────────────────────────────');
        console.log('   Total Monthly (P&I + Tax):', '$' + breakdown.total_pi_plus_tax.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      }
      
      console.log('\n   Total Interest Over Life:', '$' + dashboard.summary.mortgage.estimated_total_interest.toLocaleString('en-US', { maximumFractionDigits: 0 }));
      console.log('   Total Amount Paid:', '$' + dashboard.summary.mortgage.estimated_total_paid.toLocaleString('en-US', { maximumFractionDigits: 0 }));
    }
    
    // Show assumability analysis
    if (dashboard.summary.mortgage.assumability) {
      const assumability = dashboard.summary.mortgage.assumability;
      console.log('\n🏦 ASSUMABILITY ANALYSIS:');
      console.log('   Status:', assumability.assumable.toUpperCase(), `(${assumability.confidence} confidence)`);
      console.log('   Reason:', assumability.reason);
      if (assumability.attractiveness) {
        console.log('   Financial Attractiveness:', assumability.attractiveness.replace(/_/g, ' ').toUpperCase());
      }
      if (assumability.nextSteps && assumability.nextSteps.length > 0) {
        console.log('\n   Next Steps:');
        assumability.nextSteps.forEach((step, i) => {
          console.log(`     ${i + 1}. ${step}`);
        });
      }
      console.log('\n   📝', assumability.disclaimer);
    }
  }
  
  if (dashboard.summary.owner) {
    console.log('\n--- Owner Information ---');
    console.log('Owner 1:', dashboard.summary.owner.owner1_name);
    if (dashboard.summary.owner.owner3_name) {
      console.log('Owner 2:', dashboard.summary.owner.owner3_name);
    }
    console.log('Absentee Status:', dashboard.summary.owner.absentee_status === 'O' ? 'Owner Occupied' : 'Absentee');
    console.log('Mailing Address:', dashboard.summary.owner.mailing_address);
  }
  
  console.log('\n✅ Integration successful!\n');
  
} catch (error) {
  console.error('\n❌ Error:', error.message);
  console.error(error.stack);
}
