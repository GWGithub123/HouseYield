import 'dotenv/config';

const FRED_API_KEY = process.env.FRED_API_KEY;
const loanDate = '2022-05-05';
const loanAmount = 595000;
const term = 360; // months

console.log('\n=== Estimating Mortgage Interest Rate ===\n');
console.log('Loan Date:', loanDate);
console.log('Loan Amount:', '$' + loanAmount.toLocaleString());

// Get 30-year fixed mortgage rate from FRED for the week of the loan
async function getHistoricalMortgageRate(date) {
  // MORTGAGE30US = 30-Year Fixed Rate Mortgage Average in the United States
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=MORTGAGE30US&api_key=${FRED_API_KEY}&file_type=json&observation_start=${date}&observation_end=${date}&sort_order=desc`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.observations && data.observations.length > 0) {
      return parseFloat(data.observations[0].value);
    }
    
    // If exact date not available, get closest prior date
    const priorDate = new Date(date);
    priorDate.setDate(priorDate.getDate() - 7); // Go back 1 week
    const priorDateStr = priorDate.toISOString().split('T')[0];
    
    const urlPrior = `https://api.stlouisfed.org/fred/series/observations?series_id=MORTGAGE30US&api_key=${FRED_API_KEY}&file_type=json&observation_start=${priorDateStr}&observation_end=${date}&sort_order=desc&limit=1`;
    const responsePrior = await fetch(urlPrior);
    const dataPrior = await responsePrior.json();
    
    if (dataPrior.observations && dataPrior.observations.length > 0) {
      return parseFloat(dataPrior.observations[0].value);
    }
    
    return null;
  } catch (error) {
    console.error('Error fetching FRED data:', error.message);
    return null;
  }
}

function calculateMonthlyPayment(principal, annualRate, termMonths) {
  const monthlyRate = annualRate / 100 / 12;
  const monthlyPayment = principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / 
                         (Math.pow(1 + monthlyRate, termMonths) - 1);
  return monthlyPayment;
}

function calculateLoanToValue(loanAmount, rate) {
  // Common LTV ratios and down payments
  const estimates = [
    { ltv: 80, downPct: 20 },
    { ltv: 90, downPct: 10 },
    { ltv: 95, downPct: 5 },
    { ltv: 97, downPct: 3 }
  ];
  
  return estimates.map(({ ltv, downPct }) => {
    const propertyValue = loanAmount / (ltv / 100);
    const downPayment = propertyValue * (downPct / 100);
    return { ltv, downPct, propertyValue, downPayment };
  });
}

// Run the estimation
const rate = await getHistoricalMortgageRate(loanDate);

if (rate) {
  console.log('\n📊 Historical 30-Year Fixed Rate (Week of', loanDate + '):', rate + '%');
  console.log('   Source: Federal Reserve Economic Data (FRED)');
  
  const monthlyPayment = calculateMonthlyPayment(loanAmount, rate, term);
  console.log('\n💰 Estimated Monthly Payment (Principal & Interest):');
  console.log('   $' + monthlyPayment.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  
  const totalPaid = monthlyPayment * term;
  const totalInterest = totalPaid - loanAmount;
  
  console.log('\n📈 Loan Details:');
  console.log('   Total Amount Paid:', '$' + totalPaid.toLocaleString('en-US', { maximumFractionDigits: 0 }));
  console.log('   Total Interest:', '$' + totalInterest.toLocaleString('en-US', { maximumFractionDigits: 0 }));
  console.log('   Interest as % of Loan:', (totalInterest / loanAmount * 100).toFixed(1) + '%');
  
  // LTV estimates
  console.log('\n🏠 Estimated Property Value & Down Payment:');
  const ltvScenarios = calculateLoanToValue(loanAmount, rate);
  ltvScenarios.forEach(({ ltv, downPct, propertyValue, downPayment }) => {
    console.log(`   ${ltv}% LTV (${downPct}% down): Property Value $${propertyValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}, Down Payment $${downPayment.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  });
  
  console.log('\n📝 Accuracy Notes:');
  console.log('   • Rate is based on national average for 30-year fixed mortgages');
  console.log('   • Actual rate may vary ±0.25-1% based on:');
  console.log('     - Credit score (higher score = lower rate)');
  console.log('     - Down payment (larger down = lower rate)');
  console.log('     - Debt-to-income ratio');
  console.log('     - Property type & location');
  console.log('   • Does NOT include property taxes, insurance, or PMI');
  
} else {
  console.log('\n❌ Could not retrieve historical rate data');
}
