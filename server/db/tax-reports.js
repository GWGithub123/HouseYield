/**
 * Tax Reporting Engine
 * Schedule E preparation, annual summaries, and tax-ready reports
 * For rental property owners filing as landlords
 */

import { getDb } from './connection.js';

/**
 * Schedule E Line Item Categories
 * Maps account codes to IRS Schedule E lines
 */
export const SCHEDULE_E_LINES = {
  // Income
  RENTS_RECEIVED: { line: 3, name: 'Rents Received', accountCodes: ['4000', '4020'] },
  OTHER_INCOME: { line: 4, name: 'Other Income', accountCodes: ['4010'] },
  
  // Expenses (Lines 5-19)
  ADVERTISING: { line: 5, name: 'Advertising', accountCodes: ['5070'] },
  AUTO_TRAVEL: { line: 6, name: 'Auto and Travel', accountCodes: ['5100'] },
  CLEANING_MAINTENANCE: { line: 7, name: 'Cleaning and Maintenance', accountCodes: ['5000'] },
  COMMISSIONS: { line: 8, name: 'Commissions', accountCodes: ['5110'] },
  INSURANCE: { line: 9, name: 'Insurance', accountCodes: ['5020'] },
  LEGAL_PROFESSIONAL: { line: 10, name: 'Legal and Other Professional Fees', accountCodes: ['5120'] },
  MANAGEMENT_FEES: { line: 11, name: 'Management Fees', accountCodes: ['5040'] },
  MORTGAGE_INTEREST: { line: 12, name: 'Mortgage Interest Paid to Banks', accountCodes: ['5050'] },
  OTHER_INTEREST: { line: 13, name: 'Other Interest', accountCodes: ['5060'] },
  REPAIRS: { line: 14, name: 'Repairs', accountCodes: ['5000'] },
  SUPPLIES: { line: 15, name: 'Supplies', accountCodes: ['5080'] },
  TAXES: { line: 16, name: 'Taxes', accountCodes: ['5030'] },
  UTILITIES: { line: 17, name: 'Utilities', accountCodes: ['5010'] },
  DEPRECIATION: { line: 18, name: 'Depreciation Expense or Depletion', accountCodes: ['5090'] },
  OTHER: { line: 19, name: 'Other', accountCodes: ['5999'] }
};

/**
 * Get comprehensive tax year data
 * @param {number} taxYear - Tax year (e.g., 2025)
 * @param {number|null} propertyId - Optional property filter
 */
export function getTaxYearSummary(taxYear, propertyId = null) {
  const db = getDb();
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;
  
  // Get all revenue and expense accounts with their tax mappings
  let query = `
    SELECT 
      a.code,
      a.name,
      a.type,
      a.tax_map,
      SUM(CASE WHEN jl.dc = 'D' THEN jl.amount ELSE 0 END) AS total_debits,
      SUM(CASE WHEN jl.dc = 'C' THEN jl.amount ELSE 0 END) AS total_credits,
      SUM(
        CASE 
          WHEN a.type = 'EXPENSE' AND jl.dc = 'D' THEN jl.amount
          WHEN a.type = 'EXPENSE' AND jl.dc = 'C' THEN -jl.amount
          WHEN a.type = 'REVENUE' AND jl.dc = 'C' THEN jl.amount
          WHEN a.type = 'REVENUE' AND jl.dc = 'D' THEN -jl.amount
          ELSE 0
        END
      ) AS net_amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type IN ('REVENUE', 'EXPENSE')
  `;
  
  const params = [startDate, endDate];
  
  if (propertyId) {
    query += ` AND jl.property_id = ?`;
    params.push(propertyId);
  }
  
  query += `
    GROUP BY a.code, a.name, a.type, a.tax_map
    HAVING ABS(net_amount) > 0.01
    ORDER BY a.type DESC, a.code
  `;
  
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  
  // Separate revenue and expenses
  const income = rows
    .filter(r => r.type === 'REVENUE')
    .map(r => ({
      code: r.code,
      name: r.name,
      taxMapping: r.tax_map,
      amount: Math.abs(parseFloat(r.net_amount))
    }));
  
  const expenses = rows
    .filter(r => r.type === 'EXPENSE')
    .map(r => ({
      code: r.code,
      name: r.name,
      taxMapping: r.tax_map,
      amount: Math.abs(parseFloat(r.net_amount))
    }));
  
  const totalIncome = income.reduce((sum, i) => sum + i.amount, 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  
  return {
    taxYear,
    propertyId,
    period: { start: startDate, end: endDate },
    income,
    expenses,
    summary: {
      totalIncome,
      totalExpenses,
      netIncome: totalIncome - totalExpenses,
      effectiveTaxRate: null // Calculate based on user's tax bracket
    }
  };
}

/**
 * Generate Schedule E report
 * @param {number} taxYear - Tax year
 * @param {number|null} propertyId - Optional property filter
 */
export function getScheduleE(taxYear, propertyId = null) {
  const db = getDb();
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;
  
  // Get property info if specific property
  let propertyInfo = null;
  if (propertyId) {
    const propStmt = db.prepare('SELECT * FROM properties WHERE id = ?');
    propertyInfo = propStmt.get(propertyId);
  }
  
  // Build Schedule E line items
  const scheduleEData = {};
  
  for (const [key, lineInfo] of Object.entries(SCHEDULE_E_LINES)) {
    if (lineInfo.accountCodes.length === 0) {
      scheduleEData[key] = {
        line: lineInfo.line,
        name: lineInfo.name,
        amount: 0
      };
      continue;
    }
    
    const placeholders = lineInfo.accountCodes.map(() => '?').join(',');
    let query = `
      SELECT 
        SUM(
          CASE 
            WHEN a.type = 'EXPENSE' AND jl.dc = 'D' THEN jl.amount
            WHEN a.type = 'EXPENSE' AND jl.dc = 'C' THEN -jl.amount
            WHEN a.type = 'REVENUE' AND jl.dc = 'C' THEN jl.amount
            WHEN a.type = 'REVENUE' AND jl.dc = 'D' THEN -jl.amount
            ELSE 0
          END
        ) AS total
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id
      WHERE je.entry_date BETWEEN ? AND ?
        AND a.code IN (${placeholders})
    `;
    
    const params = [startDate, endDate, ...lineInfo.accountCodes];
    
    if (propertyId) {
      query += ` AND jl.property_id = ?`;
      params.push(propertyId);
    }
    
    const stmt = db.prepare(query);
    const result = stmt.get(...params);
    
    scheduleEData[key] = {
      line: lineInfo.line,
      name: lineInfo.name,
      amount: Math.abs(parseFloat(result?.total || 0))
    };
  }
  
  // Calculate totals
  const totalIncome = scheduleEData.RENTS_RECEIVED.amount + scheduleEData.OTHER_INCOME.amount;
  const totalExpenses = Object.entries(scheduleEData)
    .filter(([key]) => !['RENTS_RECEIVED', 'OTHER_INCOME'].includes(key))
    .reduce((sum, [, data]) => sum + data.amount, 0);
  
  return {
    taxYear,
    propertyId,
    propertyInfo,
    scheduleELines: scheduleEData,
    summary: {
      totalIncome,
      totalExpenses,
      netIncomeOrLoss: totalIncome - totalExpenses,
      line20Total: totalExpenses, // Total Expenses (Line 20)
      line21Income: totalIncome - totalExpenses // Income or Loss (Line 21)
    }
  };
}

/**
 * Get quarterly estimated tax data
 * @param {number} taxYear - Tax year
 * @param {number} quarter - Quarter (1-4)
 */
export function getQuarterlyEstimate(taxYear, quarter, propertyId = null) {
  const db = getDb();
  
  // Calculate quarter dates
  const quarterDates = {
    1: { start: `${taxYear}-01-01`, end: `${taxYear}-03-31` },
    2: { start: `${taxYear}-04-01`, end: `${taxYear}-06-30` },
    3: { start: `${taxYear}-07-01`, end: `${taxYear}-09-30` },
    4: { start: `${taxYear}-10-01`, end: `${taxYear}-12-31` }
  };
  
  const { start, end } = quarterDates[quarter];
  
  // Get income and expenses for the quarter
  let query = `
    SELECT 
      a.type,
      SUM(
        CASE 
          WHEN a.type = 'EXPENSE' AND jl.dc = 'D' THEN jl.amount
          WHEN a.type = 'EXPENSE' AND jl.dc = 'C' THEN -jl.amount
          WHEN a.type = 'REVENUE' AND jl.dc = 'C' THEN jl.amount
          WHEN a.type = 'REVENUE' AND jl.dc = 'D' THEN -jl.amount
          ELSE 0
        END
      ) AS total
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type IN ('REVENUE', 'EXPENSE')
  `;
  
  const params = [start, end];
  
  if (propertyId) {
    query += ` AND jl.property_id = ?`;
    params.push(propertyId);
  }
  
  query += ` GROUP BY a.type`;
  
  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  
  const income = rows.find(r => r.type === 'REVENUE')?.total || 0;
  const expenses = rows.find(r => r.type === 'EXPENSE')?.total || 0;
  const netIncome = Math.abs(income) - Math.abs(expenses);
  
  // Estimate quarterly tax (simplified - self-employment for rental income)
  // Note: Rental income is typically passive and not subject to SE tax
  const estimatedFederalTax = netIncome > 0 ? netIncome * 0.24 : 0; // Assumed 24% bracket
  const estimatedStateTax = netIncome > 0 ? netIncome * 0.05 : 0; // Assumed 5% state
  
  // Due dates for estimated taxes
  const dueDates = {
    1: `${taxYear}-04-15`,
    2: `${taxYear}-06-15`,
    3: `${taxYear}-09-15`,
    4: `${taxYear + 1}-01-15`
  };
  
  return {
    taxYear,
    quarter,
    period: { start, end },
    propertyId,
    income: Math.abs(income),
    expenses: Math.abs(expenses),
    netIncome,
    estimatedTax: {
      federal: estimatedFederalTax,
      state: estimatedStateTax,
      total: estimatedFederalTax + estimatedStateTax
    },
    dueDate: dueDates[quarter],
    formNumber: '1040-ES'
  };
}

/**
 * Get depreciation schedule for tax purposes
 * @param {number} taxYear - Tax year
 */
export function getDepreciationSchedule(taxYear, propertyId = null) {
  const db = getDb();
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;
  
  let query = `
    SELECT 
      fa.*,
      p.name AS property_name,
      p.address AS property_address
    FROM fixed_assets fa
    LEFT JOIN properties p ON p.id = fa.property_id
    WHERE fa.is_active = 1
  `;
  
  const params = [];
  
  if (propertyId) {
    query += ` AND fa.property_id = ?`;
    params.push(propertyId);
  }
  
  const stmt = db.prepare(query);
  const assets = stmt.all(...params);
  
  const schedule = assets.map(asset => {
    const depreciableBasis = asset.cost - asset.salvage;
    const monthlyDepreciation = depreciableBasis / asset.life_months;
    const annualDepreciation = monthlyDepreciation * 12;
    
    // Calculate months in service during tax year
    const placedInService = new Date(asset.placed_in_service);
    const yearStart = new Date(`${taxYear}-01-01`);
    const yearEnd = new Date(`${taxYear}-12-31`);
    
    let monthsInService = 12;
    if (placedInService > yearStart) {
      monthsInService = 12 - placedInService.getMonth();
    }
    
    const currentYearDepreciation = monthlyDepreciation * monthsInService;
    
    // Calculate accumulated depreciation
    const monthsSincePlaced = Math.floor(
      (yearEnd - placedInService) / (1000 * 60 * 60 * 24 * 30)
    );
    const accumulatedDepreciation = Math.min(
      monthlyDepreciation * monthsSincePlaced,
      depreciableBasis
    );
    
    return {
      assetId: asset.id,
      propertyId: asset.property_id,
      propertyName: asset.property_name,
      propertyAddress: asset.property_address,
      description: asset.description || 'Building',
      dateAcquired: asset.placed_in_service,
      cost: asset.cost,
      salvageValue: asset.salvage,
      depreciableBasis,
      usefulLifeMonths: asset.life_months,
      usefulLifeYears: Math.round(asset.life_months / 12 * 10) / 10,
      method: asset.schedule || 'STRAIGHT_LINE',
      monthlyDepreciation,
      annualDepreciation,
      currentYearDepreciation,
      monthsInService,
      accumulatedDepreciation,
      remainingBasis: depreciableBasis - accumulatedDepreciation
    };
  });
  
  const totalCurrentYear = schedule.reduce((sum, s) => sum + s.currentYearDepreciation, 0);
  const totalAccumulated = schedule.reduce((sum, s) => sum + s.accumulatedDepreciation, 0);
  
  return {
    taxYear,
    propertyId,
    assets: schedule,
    summary: {
      assetCount: schedule.length,
      totalCost: schedule.reduce((sum, s) => sum + s.cost, 0),
      totalCurrentYearDepreciation: totalCurrentYear,
      totalAccumulatedDepreciation: totalAccumulated
    },
    formNumber: 'Form 4562 - Depreciation and Amortization'
  };
}

/**
 * Get 1099 reportable payments (vendors paid over $600)
 * @param {number} taxYear - Tax year
 */
export function get1099Vendors(taxYear, propertyId = null) {
  const db = getDb();
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;
  
  // Get vendors with payments over $600
  let query = `
    SELECT 
      je.memo AS vendor_name,
      COUNT(je.id) AS payment_count,
      SUM(jl.amount) AS total_paid,
      MIN(je.entry_date) AS first_payment,
      MAX(je.entry_date) AS last_payment
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type = 'EXPENSE'
      AND jl.dc = 'D'
      AND je.memo IS NOT NULL
      AND je.memo != ''
  `;
  
  const params = [startDate, endDate];
  
  if (propertyId) {
    query += ` AND jl.property_id = ?`;
    params.push(propertyId);
  }
  
  query += `
    GROUP BY je.memo
    HAVING SUM(jl.amount) >= 600
    ORDER BY total_paid DESC
  `;
  
  const stmt = db.prepare(query);
  const vendors = stmt.all(...params);
  
  return {
    taxYear,
    propertyId,
    threshold: 600,
    vendors: vendors.map(v => ({
      name: v.vendor_name,
      paymentCount: v.payment_count,
      totalPaid: parseFloat(v.total_paid),
      firstPayment: v.first_payment,
      lastPayment: v.last_payment,
      requires1099: true
    })),
    summary: {
      vendorCount: vendors.length,
      totalReportable: vendors.reduce((sum, v) => sum + parseFloat(v.total_paid), 0)
    },
    formNumber: '1099-NEC / 1099-MISC',
    dueDate: `${taxYear + 1}-01-31`
  };
}

/**
 * Get cash vs accrual comparison
 * Helps property owners understand timing differences
 */
export function getCashVsAccrualComparison(taxYear, propertyId = null) {
  const db = getDb();
  const startDate = `${taxYear}-01-01`;
  const endDate = `${taxYear}-12-31`;
  
  // Cash basis - actual cash received/paid
  let cashQuery = `
    SELECT 
      a.type,
      SUM(
        CASE 
          WHEN a.type = 'REVENUE' AND jl.dc = 'C' THEN jl.amount
          WHEN a.type = 'EXPENSE' AND jl.dc = 'D' THEN jl.amount
          ELSE 0
        END
      ) AS total
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type IN ('REVENUE', 'EXPENSE')
      AND a.code LIKE '1%' OR je.source = 'BANK'
  `;
  
  const cashParams = [startDate, endDate];
  if (propertyId) {
    cashQuery += ` AND jl.property_id = ?`;
    cashParams.push(propertyId);
  }
  cashQuery += ` GROUP BY a.type`;
  
  // Accrual basis - includes AR/AP adjustments
  let accrualQuery = `
    SELECT 
      a.type,
      SUM(
        CASE 
          WHEN a.type = 'REVENUE' AND jl.dc = 'C' THEN jl.amount
          WHEN a.type = 'EXPENSE' AND jl.dc = 'D' THEN jl.amount
          ELSE 0
        END
      ) AS total
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.entry_date BETWEEN ? AND ?
      AND a.type IN ('REVENUE', 'EXPENSE')
  `;
  
  const accrualParams = [startDate, endDate];
  if (propertyId) {
    accrualQuery += ` AND jl.property_id = ?`;
    accrualParams.push(propertyId);
  }
  accrualQuery += ` GROUP BY a.type`;
  
  // For simplicity, use the same data (full accrual basis)
  // In a full implementation, you'd track cash movements separately
  const stmt = db.prepare(accrualQuery);
  const rows = stmt.all(...accrualParams);
  
  const revenue = Math.abs(rows.find(r => r.type === 'REVENUE')?.total || 0);
  const expenses = Math.abs(rows.find(r => r.type === 'EXPENSE')?.total || 0);
  
  return {
    taxYear,
    propertyId,
    cashBasis: {
      revenue,
      expenses,
      netIncome: revenue - expenses
    },
    accrualBasis: {
      revenue,
      expenses,
      netIncome: revenue - expenses
    },
    difference: {
      revenue: 0,
      expenses: 0,
      netIncome: 0
    },
    recommendation: 'Most small landlords use cash basis accounting for simplicity. Consult a tax professional for your specific situation.'
  };
}

/**
 * Get year-over-year comparison
 */
export function getYearOverYearComparison(taxYear, propertyId = null) {
  const currentYear = getTaxYearSummary(taxYear, propertyId);
  const previousYear = getTaxYearSummary(taxYear - 1, propertyId);
  
  const incomeChange = currentYear.summary.totalIncome - previousYear.summary.totalIncome;
  const expenseChange = currentYear.summary.totalExpenses - previousYear.summary.totalExpenses;
  const netIncomeChange = currentYear.summary.netIncome - previousYear.summary.netIncome;
  
  const incomeChangePercent = previousYear.summary.totalIncome > 0 
    ? (incomeChange / previousYear.summary.totalIncome) * 100 
    : 0;
  const expenseChangePercent = previousYear.summary.totalExpenses > 0 
    ? (expenseChange / previousYear.summary.totalExpenses) * 100 
    : 0;
  const netIncomeChangePercent = previousYear.summary.netIncome !== 0 
    ? (netIncomeChange / Math.abs(previousYear.summary.netIncome)) * 100 
    : 0;
  
  return {
    currentYear: {
      year: taxYear,
      ...currentYear.summary
    },
    previousYear: {
      year: taxYear - 1,
      ...previousYear.summary
    },
    changes: {
      income: {
        amount: incomeChange,
        percent: Math.round(incomeChangePercent * 10) / 10
      },
      expenses: {
        amount: expenseChange,
        percent: Math.round(expenseChangePercent * 10) / 10
      },
      netIncome: {
        amount: netIncomeChange,
        percent: Math.round(netIncomeChangePercent * 10) / 10
      }
    },
    propertyId
  };
}

/**
 * Get tax document checklist
 */
export function getTaxDocumentChecklist(taxYear, propertyId = null) {
  const scheduleE = getScheduleE(taxYear, propertyId);
  const depreciation = getDepreciationSchedule(taxYear, propertyId);
  const vendors1099 = get1099Vendors(taxYear, propertyId);
  
  const documents = [
    {
      name: 'Form 1040 - Individual Income Tax Return',
      required: true,
      status: 'pending',
      dueDate: `${taxYear + 1}-04-15`
    },
    {
      name: 'Schedule E - Supplemental Income and Loss',
      required: scheduleE.summary.totalIncome > 0 || scheduleE.summary.totalExpenses > 0,
      status: 'data_ready',
      dueDate: `${taxYear + 1}-04-15`,
      preview: {
        income: scheduleE.summary.totalIncome,
        expenses: scheduleE.summary.totalExpenses,
        netIncomeOrLoss: scheduleE.summary.line21Income
      }
    },
    {
      name: 'Form 4562 - Depreciation and Amortization',
      required: depreciation.assets.length > 0,
      status: depreciation.assets.length > 0 ? 'data_ready' : 'not_applicable',
      dueDate: `${taxYear + 1}-04-15`,
      preview: {
        assetCount: depreciation.summary.assetCount,
        totalDepreciation: depreciation.summary.totalCurrentYearDepreciation
      }
    },
    {
      name: '1099-NEC Forms (for contractors)',
      required: vendors1099.vendors.length > 0,
      status: vendors1099.vendors.length > 0 ? 'action_required' : 'not_applicable',
      dueDate: `${taxYear + 1}-01-31`,
      preview: {
        vendorCount: vendors1099.summary.vendorCount,
        totalReportable: vendors1099.summary.totalReportable
      }
    },
    {
      name: 'Mortgage Interest Statement (Form 1098)',
      required: scheduleE.scheduleELines.MORTGAGE_INTEREST.amount > 0,
      status: scheduleE.scheduleELines.MORTGAGE_INTEREST.amount > 0 ? 'data_ready' : 'not_applicable',
      dueDate: `${taxYear + 1}-01-31`,
      preview: {
        interestReported: scheduleE.scheduleELines.MORTGAGE_INTEREST.amount
      }
    },
    {
      name: 'Property Tax Records',
      required: scheduleE.scheduleELines.TAXES.amount > 0,
      status: 'data_ready',
      dueDate: `${taxYear + 1}-04-15`,
      preview: {
        taxesPaid: scheduleE.scheduleELines.TAXES.amount
      }
    },
    {
      name: 'Insurance Premium Records',
      required: scheduleE.scheduleELines.INSURANCE.amount > 0,
      status: 'data_ready',
      dueDate: `${taxYear + 1}-04-15`,
      preview: {
        premiumsPaid: scheduleE.scheduleELines.INSURANCE.amount
      }
    },
    {
      name: 'Repair and Maintenance Receipts',
      required: scheduleE.scheduleELines.REPAIRS.amount > 0,
      status: 'data_ready',
      dueDate: `${taxYear + 1}-04-15`,
      preview: {
        totalRepairs: scheduleE.scheduleELines.REPAIRS.amount
      }
    }
  ];
  
  return {
    taxYear,
    propertyId,
    documents,
    summary: {
      totalDocuments: documents.length,
      required: documents.filter(d => d.required).length,
      ready: documents.filter(d => d.status === 'data_ready').length,
      actionRequired: documents.filter(d => d.status === 'action_required').length,
      nextDeadline: documents
        .filter(d => d.required)
        .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0]?.dueDate
    }
  };
}

/**
 * Export tax data as CSV for tax software import
 */
export function exportTaxDataCSV(taxYear, propertyId = null) {
  const scheduleE = getScheduleE(taxYear, propertyId);
  
  const rows = [
    ['Schedule E Tax Report', ''],
    ['Tax Year', taxYear],
    ['Generated', new Date().toISOString()],
    [''],
    ['Line', 'Description', 'Amount'],
    ...Object.entries(scheduleE.scheduleELines).map(([key, data]) => [
      data.line,
      data.name,
      data.amount.toFixed(2)
    ]),
    [''],
    ['Summary', '', ''],
    ['Total Income', '', scheduleE.summary.totalIncome.toFixed(2)],
    ['Total Expenses', '', scheduleE.summary.totalExpenses.toFixed(2)],
    ['Net Income/Loss', '', scheduleE.summary.line21Income.toFixed(2)]
  ];
  
  return rows.map(row => row.join(',')).join('\n');
}
