/**
 * Mock ATTOM Property Data
 * =========================
 * Simulates ATTOM API responses for 2 rental properties.
 * Mirrors the structure returned by server/attom.js → getFullPropertyReport()
 * with tax assessment, AVM, sale history, and mortgage data.
 */

export const MOCK_ATTOM_DATA = {
  'Elm Street Duplex': {
    address: {
      oneLine: '742 Elm Street, Raleigh, NC 27601',
      line1: '742 Elm Street',
      line2: 'Raleigh, NC 27601',
      locality: 'Raleigh',
      countrySubd: 'NC',
      postal1: '27601',
      country: 'US'
    },
    
    summary: {
      propType: 'SFR',
      propSubType: 'Duplex',
      yearBuilt: 1987,
      bedrooms: 4,
      bathrooms: 3,
      livingSize: 2400,
      lotSize: 8712,
      stories: 2,
      construction: 'Frame',
      roofType: 'Asphalt Shingle',
      heating: 'Central',
      cooling: 'Central',
      garage: '2-Car Attached',
      pool: false,
      zoning: 'R-6'
    },

    assessment: {
      assessed: {
        assdTtlValue: 392500,
        assdLandValue: 88000,
        assdImprValue: 304500
      },
      market: {
        mktTtlValue: 485000,
        mktLandValue: 97000,
        mktImprValue: 388000
      },
      tax: {
        taxAmt: 7500,
        taxYear: 2024
      },
      assessmentYear: 2024
    },

    assessmentHistory: [
      {
        year: 2024,
        assessed: { assdTtlValue: 392500, assdLandValue: 88000, assdImprValue: 304500 },
        tax: { taxAmt: 7500 }
      },
      {
        year: 2023,
        assessed: { assdTtlValue: 375000, assdLandValue: 85000, assdImprValue: 290000 },
        tax: { taxAmt: 7200 }
      },
      {
        year: 2022,
        assessed: { assdTtlValue: 360000, assdLandValue: 82000, assdImprValue: 278000 },
        tax: { taxAmt: 6950 }
      }
    ],

    avm: {
      amount: { value: 497000, low: 472000, high: 522000 },
      eventDate: '2025-01-15',
      confidence: 85,
      changeLastYear: 2.5,
      changeLastYearValue: 12075
    },

    rentalAvm: {
      amount: { value: 3650, low: 3400, high: 3900 },
      eventDate: '2025-01-15',
      rentYield: 8.8
    },

    saleHistory: [
      {
        saleDate: '2022-05-15',
        salePrice: 425000,
        saleType: 'Arms Length',
        deedType: 'Warranty Deed',
        buyer: 'Renaissance Property Holdings LLC',
        seller: 'Johnson Family Trust'
      },
      {
        saleDate: '2015-08-22',
        salePrice: 268000,
        saleType: 'Arms Length',
        deedType: 'Warranty Deed'
      }
    ],

    mortgage: {
      amount: 340000,
      lender: 'Wells Fargo Home Mortgage',
      rate: 5.25,
      rateType: 'Fixed',
      term: 360,
      dueDate: '2052-06-01',
      interestAmount: null,
      loanType: 'Conventional',
      date: '2022-05-15'
    },

    owner: {
      name: 'Renaissance Property Holdings LLC',
      mailingAddress: '100 Capital Blvd, Suite 200, Raleigh, NC 27601',
      ownerType: 'Corporation'
    },

    hazards: {
      floodZone: 'X',
      floodRisk: 'Minimal',
      earthquakeRisk: 'Very Low',
      hurricaneRisk: 'Moderate',
      wildfire: 'Low'
    },

    schools: [
      { name: 'Elm Street Elementary', type: 'Elementary', distance: 0.4, rating: 7 },
      { name: 'Martin Middle School', type: 'Middle', distance: 1.2, rating: 6 },
      { name: 'Broughton High School', type: 'High', distance: 2.1, rating: 8 }
    ]
  },

  'Oakwood Condo': {
    address: {
      oneLine: '1120 Oakwood Ave, Unit 4B, Durham, NC 27705',
      line1: '1120 Oakwood Ave, Unit 4B',
      line2: 'Durham, NC 27705',
      locality: 'Durham',
      countrySubd: 'NC',
      postal1: '27705',
      country: 'US'
    },
    
    summary: {
      propType: 'Condo',
      propSubType: 'Condo',
      yearBuilt: 2005,
      bedrooms: 2,
      bathrooms: 2,
      livingSize: 1150,
      lotSize: 0,
      stories: 1,
      construction: 'Masonry',
      roofType: 'Flat/Built-Up',
      heating: 'Central',
      cooling: 'Central',
      garage: '1-Car Covered',
      pool: true,
      zoning: 'R-10'
    },

    assessment: {
      assessed: {
        assdTtlValue: 264000,
        assdLandValue: 39600,
        assdImprValue: 224400
      },
      market: {
        mktTtlValue: 312000,
        mktLandValue: 46800,
        mktImprValue: 265200
      },
      tax: {
        taxAmt: 4960,
        taxYear: 2024
      },
      assessmentYear: 2024
    },

    assessmentHistory: [
      {
        year: 2024,
        assessed: { assdTtlValue: 264000, assdLandValue: 39600, assdImprValue: 224400 },
        tax: { taxAmt: 4960 }
      },
      {
        year: 2023,
        assessed: { assdTtlValue: 252000, assdLandValue: 37800, assdImprValue: 214200 },
        tax: { taxAmt: 4725 }
      }
    ],

    avm: {
      amount: { value: 318000, low: 302000, high: 334000 },
      eventDate: '2025-01-15',
      confidence: 88,
      changeLastYear: 3.1,
      changeLastYearValue: 9558
    },

    rentalAvm: {
      amount: { value: 1750, low: 1600, high: 1900 },
      eventDate: '2025-01-15',
      rentYield: 6.6
    },

    saleHistory: [
      {
        saleDate: '2023-08-01',
        salePrice: 285000,
        saleType: 'Arms Length',
        deedType: 'Warranty Deed',
        buyer: 'Renaissance Property Holdings LLC',
        seller: 'Oakwood Development Group'
      }
    ],

    mortgage: {
      amount: 228000,
      lender: 'First Citizens Bank',
      rate: 6.75,
      rateType: 'Fixed',
      term: 360,
      dueDate: '2053-09-01',
      interestAmount: null,
      loanType: 'Conventional',
      date: '2023-08-01'
    },

    owner: {
      name: 'Renaissance Property Holdings LLC',
      mailingAddress: '100 Capital Blvd, Suite 200, Raleigh, NC 27601',
      ownerType: 'Corporation'
    },

    hazards: {
      floodZone: 'X',
      floodRisk: 'Minimal',
      earthquakeRisk: 'Very Low',
      hurricaneRisk: 'Moderate',
      wildfire: 'Low'
    },

    schools: [
      { name: 'Oakwood Elementary', type: 'Elementary', distance: 0.3, rating: 8 },
      { name: 'Durham Academy Middle', type: 'Middle', distance: 1.5, rating: 9 },
      { name: 'Durham School of Arts', type: 'High', distance: 2.8, rating: 9 }
    ]
  }
};


/**
 * Mock vendors for 1099 tracking
 * These match the vendors used in mock-bank-transactions.js
 */
export const MOCK_VENDORS = [
  {
    name: "Mike's Plumbing LLC",
    vendorType: 'llc',
    ein: '56-1234567',
    address: '310 S Wilmington St',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    email: 'mike@mikesplumbing.com',
    phone: '919-555-0101',
    w9OnFile: true,
    w9Date: '2024-12-15'
  },
  {
    name: 'Carolina Comfort HVAC',
    vendorType: 'llc',
    ein: '56-2345678',
    address: '420 W Cabarrus St',
    city: 'Raleigh',
    state: 'NC',
    zip: '27603',
    email: 'service@carolinacomfort.com',
    phone: '919-555-0202',
    w9OnFile: true,
    w9Date: '2025-01-10'
  },
  {
    name: 'Green Thumb Lawn Care',
    vendorType: 'individual',
    ssnLast4: '4567',
    address: '88 Forest Hills Dr',
    city: 'Raleigh',
    state: 'NC',
    zip: '27609',
    email: 'greenthumb@email.com',
    phone: '919-555-0303',
    w9OnFile: false,
    w9Date: ''
  },
  {
    name: 'CleanPro Services',
    vendorType: 'llc',
    ein: '56-3456789',
    address: '200 E Martin St',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    email: 'info@cleanproservices.com',
    phone: '919-555-0404',
    w9OnFile: true,
    w9Date: '2025-02-20'
  },
  {
    name: 'Bright Spark Electric LLC',
    vendorType: 'llc',
    ein: '56-4567890',
    address: '155 Fayetteville St',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    email: 'jobs@brightspark.com',
    phone: '919-555-0505',
    w9OnFile: true,
    w9Date: '2025-08-05'
  },
  {
    name: 'Triangle Roofing Co',
    vendorType: 'llc',
    ein: '56-5678901',
    address: '900 New Bern Ave',
    city: 'Raleigh',
    state: 'NC',
    zip: '27610',
    email: 'bids@triangleroofing.com',
    phone: '919-555-0606',
    w9OnFile: false,
    w9Date: ''
  },
  {
    name: 'Anderson Law Group PLLC',
    vendorType: 'llc',
    ein: '56-6789012',
    address: '100 Capital Blvd, Suite 300',
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    email: 'info@andersonlawgroup.com',
    phone: '919-555-0707',
    w9OnFile: true,
    w9Date: '2024-11-01'
  },
  {
    name: 'Smith & Associates CPA',
    vendorType: 'partnership',
    ein: '56-7890123',
    address: '2100 Hillsborough St',
    city: 'Raleigh',
    state: 'NC',
    zip: '27607',
    email: 'info@smithcpa.com',
    phone: '919-555-0808',
    w9OnFile: true,
    w9Date: '2025-07-10'
  }
];
