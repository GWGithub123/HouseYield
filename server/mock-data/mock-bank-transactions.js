/**
 * Mock Rental Property Bank Transactions
 * ========================================
 * Simulates a full year of bank/Stripe transactions for a 2-property
 * rental portfolio. Covers all major Schedule E categories + edge cases.
 * 
 * These mirror what would come from a Stripe/Plaid bank import and get
 * fed through Gemini AI categorization → journal entries → Tax Center.
 */

export const MOCK_PROPERTIES = [
  {
    name: 'Elm Street Duplex',
    address: '742 Elm Street, Raleigh, NC 27601',
    state: 'NC',
    purchaseDate: '2022-05-15',
    purchasePrice: 425000,
    landValue: 85000,
    improvementValue: 340000,
    propertyType: 'Residential Rental Property',
    usefulLifeMonths: 330
  },
  {
    name: 'Oakwood Condo',
    address: '1120 Oakwood Ave, Unit 4B, Durham, NC 27705',
    state: 'NC',
    purchaseDate: '2023-08-01',
    purchasePrice: 285000,
    landValue: 42750,
    improvementValue: 242250,
    propertyType: 'Residential Rental Property',
    usefulLifeMonths: 330
  }
];

/**
 * Full year of bank transactions for 2025 tax year.
 * Each entry has the fields that come from a bank/Stripe import
 * BEFORE Gemini categorization (raw descriptions).
 * 
 * The mock loader will:
 *   1. Write these as uncategorized journal entries
 *   2. Run Gemini AI categorization on them
 *   3. Apply the categories back to each entry
 */
export const MOCK_BANK_TRANSACTIONS = [
  // ═══════════════════════════════════════════════════════════════════════
  // JANUARY 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  // --- Rent Income ---
  { date: '2025-01-03', amount: 1850, description: 'Stripe payout - Tenant Sarah Mitchell Jan rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-01-03', amount: 1850, description: 'Stripe payout - Tenant David Park Jan rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-01-04', amount: 1650, description: 'Stripe payout - Tenant James Chen Jan rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  // --- Mortgage Payments ---
  { date: '2025-01-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-01-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Insurance ---
  { date: '2025-01-15', amount: -245, description: 'State Farm landlord policy premium - Elm St', vendor: 'State Farm Insurance', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Property Taxes ---
  { date: '2025-01-10', amount: -1875, description: 'Wake County property tax installment Q1', vendor: 'Wake County Tax Office', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Repair ---
  { date: '2025-01-22', amount: -385, description: 'Mike\'s Plumbing - water heater repair unit B', vendor: 'Mike\'s Plumbing LLC', property: 'Elm Street Duplex', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // FEBRUARY 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-02-03', amount: 1850, description: 'Stripe payout - Sarah Mitchell Feb rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-02-03', amount: 1850, description: 'Stripe payout - David Park Feb rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-02-04', amount: 1650, description: 'Stripe payout - James Chen Feb rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-02-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-02-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Advertising ---
  { date: '2025-02-10', amount: -79, description: 'Zillow Rental Manager - premium listing', vendor: 'Zillow', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Supplies ---
  { date: '2025-02-18', amount: -127.43, description: 'Home Depot - smoke detectors, locks, paint', vendor: 'Home Depot', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Legal ---
  { date: '2025-02-25', amount: -350, description: 'Anderson Law Group - lease agreement review', vendor: 'Anderson Law Group PLLC', property: 'Elm Street Duplex', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // MARCH 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-03-03', amount: 1850, description: 'Stripe payout - Sarah Mitchell Mar rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-03-03', amount: 1850, description: 'Stripe payout - David Park Mar rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-03-04', amount: 1650, description: 'Stripe payout - James Chen Mar rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-03-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-03-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Cleaning ---
  { date: '2025-03-15', amount: -175, description: 'CleanPro Services - deep clean between tenants', vendor: 'CleanPro Services', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Utilities ---
  { date: '2025-03-18', amount: -142.60, description: 'Duke Energy - electric common areas Elm St', vendor: 'Duke Energy', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-03-20', amount: -67.30, description: 'City of Raleigh - water/sewer Elm St', vendor: 'City of Raleigh Utilities', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Late Fee Income ---
  { date: '2025-03-08', amount: 75, description: 'Late fee - David Park March rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },

  // ═══════════════════════════════════════════════════════════════════════
  // APRIL 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-04-03', amount: 1850, description: 'Stripe payout - Sarah Mitchell Apr rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-04-03', amount: 1850, description: 'Stripe payout - David Park Apr rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-04-04', amount: 1650, description: 'Stripe payout - James Chen Apr rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-04-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-04-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Property Tax Q2 ---
  { date: '2025-04-10', amount: -1875, description: 'Wake County property tax installment Q2', vendor: 'Wake County Tax Office', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-04-10', amount: -1240, description: 'Durham County property tax installment H1', vendor: 'Durham County Tax Office', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Pest Control ---
  { date: '2025-04-20', amount: -95, description: 'Terminix quarterly pest treatment', vendor: 'Terminix', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- HOA ---
  { date: '2025-04-01', amount: -275, description: 'Oakwood Homeowners Assn - monthly dues', vendor: 'Oakwood HOA', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Software ---
  { date: '2025-04-15', amount: -29, description: 'Renaissance Realty Pro subscription', vendor: 'Renaissance Realty', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // MAY 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-05-03', amount: 1850, description: 'Stripe payout - Sarah Mitchell May rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-05-03', amount: 1850, description: 'Stripe payout - David Park May rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-05-04', amount: 1650, description: 'Stripe payout - James Chen May rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-05-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-05-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Major Repair (HVAC) ---
  { date: '2025-05-12', amount: -2200, description: 'Carolina Comfort HVAC - A/C compressor replacement unit A', vendor: 'Carolina Comfort HVAC', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Landscaping ---
  { date: '2025-05-22', amount: -210, description: 'Green Thumb Lawn Care - monthly service', vendor: 'Green Thumb Lawn Care', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Tenant Screening ---
  { date: '2025-05-28', amount: -45, description: 'TransUnion SmartMove - background check', vendor: 'TransUnion SmartMove', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Insurance ---
  { date: '2025-05-15', amount: -189, description: 'Allstate landlord policy premium - Oakwood', vendor: 'Allstate Insurance', property: 'Oakwood Condo', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // JUNE 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-06-03', amount: 1850, description: 'Stripe payout - Sarah Mitchell Jun rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-06-03', amount: 1850, description: 'Stripe payout - David Park Jun rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-06-04', amount: 1650, description: 'Stripe payout - James Chen Jun rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-06-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-06-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Utilities ---
  { date: '2025-06-15', amount: -168.40, description: 'Duke Energy - electric common areas Elm St', vendor: 'Duke Energy', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-06-18', amount: -72.15, description: 'City of Raleigh - water/sewer Elm St', vendor: 'City of Raleigh Utilities', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Landscaping ---
  { date: '2025-06-22', amount: -210, description: 'Green Thumb Lawn Care - monthly service', vendor: 'Green Thumb Lawn Care', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- HOA ---
  { date: '2025-06-01', amount: -275, description: 'Oakwood Homeowners Assn - monthly dues', vendor: 'Oakwood HOA', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Auto/Travel ---
  { date: '2025-06-25', amount: -32.50, description: 'Shell gas station - property visits', vendor: 'Shell Oil', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // JULY 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-07-03', amount: 1900, description: 'Stripe payout - Sarah Mitchell Jul rent (increase)', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-07-03', amount: 1900, description: 'Stripe payout - David Park Jul rent (increase)', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-07-04', amount: 1700, description: 'Stripe payout - James Chen Jul rent (increase)', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-07-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-07-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Property Tax Q3 ---
  { date: '2025-07-10', amount: -1875, description: 'Wake County property tax installment Q3', vendor: 'Wake County Tax Office', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Pest Control ---
  { date: '2025-07-20', amount: -95, description: 'Terminix quarterly pest treatment', vendor: 'Terminix', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Appliance Repair ---
  { date: '2025-07-25', amount: -475, description: 'Sears Home Services - dishwasher repair', vendor: 'Sears Home Services', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Landscaping ---
  { date: '2025-07-22', amount: -210, description: 'Green Thumb Lawn Care - monthly service', vendor: 'Green Thumb Lawn Care', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- HOA ---
  { date: '2025-07-01', amount: -275, description: 'Oakwood Homeowners Assn - monthly dues', vendor: 'Oakwood HOA', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- CPA / Accounting ---
  { date: '2025-07-15', amount: -450, description: 'Smith & Associates CPA - rental tax prep', vendor: 'Smith & Associates CPA', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // AUGUST 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-08-03', amount: 1900, description: 'Stripe payout - Sarah Mitchell Aug rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-08-03', amount: 1900, description: 'Stripe payout - David Park Aug rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-08-04', amount: 1700, description: 'Stripe payout - James Chen Aug rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-08-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-08-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Electrical Repair ---
  { date: '2025-08-10', amount: -320, description: 'Bright Spark Electric - GFCI outlets + panel inspection', vendor: 'Bright Spark Electric LLC', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Supplies ---
  { date: '2025-08-20', amount: -89.95, description: 'Lowes - interior paint, brushes, tape', vendor: 'Lowes Home Improvement', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Landscaping ---
  { date: '2025-08-22', amount: -210, description: 'Green Thumb Lawn Care - monthly service', vendor: 'Green Thumb Lawn Care', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- HOA ---
  { date: '2025-08-01', amount: -275, description: 'Oakwood Homeowners Assn - monthly dues', vendor: 'Oakwood HOA', property: 'Oakwood Condo', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // SEPTEMBER 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-09-03', amount: 1900, description: 'Stripe payout - Sarah Mitchell Sep rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-09-03', amount: 1900, description: 'Stripe payout - David Park Sep rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-09-04', amount: 1700, description: 'Stripe payout - James Chen Sep rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-09-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-09-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Utilities ---
  { date: '2025-09-15', amount: -188.25, description: 'Duke Energy - electric common areas Elm St', vendor: 'Duke Energy', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-09-18', amount: -78.90, description: 'City of Raleigh - water/sewer Elm St', vendor: 'City of Raleigh Utilities', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-09-20', amount: -85, description: 'Spectrum internet common area - Elm St', vendor: 'Spectrum', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Security ---
  { date: '2025-09-12', amount: -249, description: 'SimpliSafe security system - annual plan', vendor: 'SimpliSafe', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- HOA ---
  { date: '2025-09-01', amount: -275, description: 'Oakwood Homeowners Assn - monthly dues', vendor: 'Oakwood HOA', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Landscaping ---
  { date: '2025-09-22', amount: -210, description: 'Green Thumb Lawn Care - monthly service', vendor: 'Green Thumb Lawn Care', property: 'Elm Street Duplex', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // OCTOBER 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-10-03', amount: 1900, description: 'Stripe payout - Sarah Mitchell Oct rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-10-03', amount: 1900, description: 'Stripe payout - David Park Oct rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-10-04', amount: 1700, description: 'Stripe payout - James Chen Oct rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-10-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-10-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Property Tax Q4 ---
  { date: '2025-10-10', amount: -1875, description: 'Wake County property tax installment Q4', vendor: 'Wake County Tax Office', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-10-10', amount: -1240, description: 'Durham County property tax installment H2', vendor: 'Durham County Tax Office', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Pest Control ---
  { date: '2025-10-20', amount: -95, description: 'Terminix quarterly pest treatment', vendor: 'Terminix', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Roof Repair ---
  { date: '2025-10-28', amount: -1850, description: 'Triangle Roofing - shingle repair + gutter', vendor: 'Triangle Roofing Co', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- HOA ---
  { date: '2025-10-01', amount: -275, description: 'Oakwood Homeowners Assn - monthly dues', vendor: 'Oakwood HOA', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Software ---
  { date: '2025-10-15', amount: -29, description: 'Renaissance Realty Pro subscription', vendor: 'Renaissance Realty', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // NOVEMBER 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-11-03', amount: 1900, description: 'Stripe payout - Sarah Mitchell Nov rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-11-03', amount: 1900, description: 'Stripe payout - David Park Nov rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-11-04', amount: 1700, description: 'Stripe payout - James Chen Nov rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-11-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-11-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Cleaning ---
  { date: '2025-11-10', amount: -200, description: 'CleanPro Services - fall deep clean unit A', vendor: 'CleanPro Services', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Utilities ---
  { date: '2025-11-15', amount: -155.80, description: 'Duke Energy - electric common areas Elm St', vendor: 'Duke Energy', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-11-18', amount: -71.25, description: 'City of Raleigh - water/sewer Elm St', vendor: 'City of Raleigh Utilities', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- HOA ---
  { date: '2025-11-01', amount: -275, description: 'Oakwood Homeowners Assn - monthly dues', vendor: 'Oakwood HOA', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Landscaping (leaf cleanup) ---
  { date: '2025-11-22', amount: -310, description: 'Green Thumb Lawn Care - fall cleanup + leaf removal', vendor: 'Green Thumb Lawn Care', property: 'Elm Street Duplex', source: 'BANK' },

  // ═══════════════════════════════════════════════════════════════════════
  // DECEMBER 2025
  // ═══════════════════════════════════════════════════════════════════════
  
  { date: '2025-12-03', amount: 1900, description: 'Stripe payout - Sarah Mitchell Dec rent', vendor: 'Sarah Mitchell', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-12-03', amount: 1900, description: 'Stripe payout - David Park Dec rent', vendor: 'David Park', property: 'Elm Street Duplex', source: 'STRIPE' },
  { date: '2025-12-04', amount: 1700, description: 'Stripe payout - James Chen Dec rent', vendor: 'James Chen', property: 'Oakwood Condo', source: 'STRIPE' },
  
  { date: '2025-12-01', amount: -2487.35, description: 'Auto-pay Wells Fargo mortgage 742 Elm St', vendor: 'Wells Fargo Home Mortgage', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-12-01', amount: -1654.22, description: 'Auto-pay First Citizens mortgage 1120 Oakwood', vendor: 'First Citizens Bank', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Insurance renewal ---
  { date: '2025-12-15', amount: -245, description: 'State Farm landlord policy renewal - Elm St', vendor: 'State Farm Insurance', property: 'Elm Street Duplex', source: 'BANK' },
  { date: '2025-12-15', amount: -189, description: 'Allstate landlord policy renewal - Oakwood', vendor: 'Allstate Insurance', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Plumbing ---
  { date: '2025-12-18', amount: -275, description: 'Mike\'s Plumbing - fix kitchen faucet leak', vendor: 'Mike\'s Plumbing LLC', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- HOA ---
  { date: '2025-12-01', amount: -275, description: 'Oakwood Homeowners Assn - monthly dues', vendor: 'Oakwood HOA', property: 'Oakwood Condo', source: 'BANK' },
  
  // --- Year-end supplies ---
  { date: '2025-12-28', amount: -68.50, description: 'Home Depot - fire extinguishers, CO detectors', vendor: 'Home Depot', property: 'Elm Street Duplex', source: 'BANK' },
  
  // --- Auto/Travel ---
  { date: '2025-12-30', amount: -28.75, description: 'BP gas station - property inspection drive', vendor: 'BP', source: 'BANK' },
  
  // --- Software ---
  { date: '2025-12-15', amount: -29, description: 'Renaissance Realty Pro subscription', vendor: 'Renaissance Realty', source: 'BANK' },
];

/**
 * Summary stats for verification:
 * ================================
 * Total Income:  ~$64,575 (rent + late fees)
 * Total Expenses: ~$63,500 (mortgage, taxes, insurance, repairs, etc.)
 * Transaction count: ~130 entries
 * Properties: 2 (Elm Street Duplex + Oakwood Condo)
 * Tenants: 3 (Sarah Mitchell, David Park, James Chen)
 * Key vendors: Wells Fargo, First Citizens, State Farm, Allstate,
 *   Mike's Plumbing, Green Thumb, CleanPro, Terminix, Duke Energy, etc.
 */
