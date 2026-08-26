// Estimate mortgage interest rate based on loan date
// Uses historical average rates for conventional loans

const loanDate = '2022-05-05';
const loanAmount = 595000;
const term = 360; // months

// Historical 30-year fixed mortgage rates (monthly averages for 2022)
// Source: Freddie Mac Primary Mortgage Market Survey
const historicalRates = {
  '2022-01': 3.22,
  '2022-02': 3.76,
  '2022-03': 4.17,
  '2022-04': 5.00,
  '2022-05': 5.30,
  '2022-06': 5.81,
  '2022-07': 5.54,
  '2022-08': 5.55,
  '2022-09': 6.11,
  '2022-10': 6.92,
  '2022-11': 6.58,
  '2022-12': 6.27,
  '2023-01': 6.15,
  '2023-02': 6.32,
  '2023-03': 6.42,
  '2023-04': 6.39,
  '2023-05': 6.57,
  '2023-06': 6.71,
  '2023-07': 6.81,
  '2023-08': 7.09,
  '2023-09': 7.18,
  '2023-10': 7.63,
  '2023-11': 7.44,
  '2023-12': 6.67,
  '2024-01': 6.69,
  '2024-02': 6.74,
  '2024-03': 6.82,
  '2024-04': 6.99,
  '2024-05': 7.02,
  '2024-06': 6.95,
  '2024-07': 6.89,
  '2024-08': 6.46,
  '2024-09': 6.08,
  '2024-10': 6.08,
};

function estimateInterestRate(loanDate) {
  const yearMonth = loanDate.substring(0, 7); // "2022-05"
  const estimatedRate = historicalRates[yearMonth];
  
  if (!estimatedRate) {
    console.log('No historical data for', yearMonth);
    return null;
  }
  
  return estimatedRate;
}

function calculateMonthlyPayment(principal, annualRate, termMonths) {
  const monthlyRate = annualRate / 100 / 12;
  const monthlyPayment = principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / 
                         (Math.pow(1 + monthlyRate, termMonths) - 1);
  return monthlyPayment;
}

console.log('\n=== Mortgage Interest Rate Estimation ===\n');
console.log('Loan Date:', loanDate);
console.log('Loan Amount:', '$' + loanAmount.toLocaleString());
console.log('Term:', term / 12, 'years');

const estimatedRate = estimateInterestRate(loanDate);

if (estimatedRate) {
  console.log('\n📊 Estimated Interest Rate:', estimatedRate + '%');
  console.log('   (Based on national average for 30-year fixed conventional mortgages in May 2022)');
  
  const monthlyPayment = calculateMonthlyPayment(loanAmount, estimatedRate, term);
  console.log('\n💰 Estimated Monthly Payment (P&I):', '$' + monthlyPayment.toFixed(2));
  
  const totalInterest = (monthlyPayment * term) - loanAmount;
  console.log('💸 Total Interest Over Life of Loan:', '$' + totalInterest.toLocaleString('en-US', {maximumFractionDigits: 0}));
  
  console.log('\n📝 Note: This is an ESTIMATE based on historical averages.');
  console.log('   Actual rate may vary based on credit score, down payment, etc.');
}
