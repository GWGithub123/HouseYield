import { randomUUID } from 'node:crypto';
import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './azureSqlClient.js';

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function mapEstimatedTaxPaymentRow(row) {
  return {
    id: row.estimated_tax_payment_id,
    taxYear: Number(row.tax_year),
    quarter: Number(row.quarter),
    amount: roundCurrency(row.amount),
    datePaid: toIsoDate(row.date_paid),
    paymentMethod: row.payment_method || 'unknown',
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

export async function recordEstimatedTaxPaymentToAzure({
  userId,
  taxYear,
  quarter,
  amount,
  datePaid = null,
  paymentMethod = 'unknown'
} = {}) {
  if (!userId) {
    throw new Error('userId is required to record an estimated tax payment');
  }

  const numericQuarter = Number(quarter);
  if (!Number.isInteger(numericQuarter) || numericQuarter < 1 || numericQuarter > 4) {
    throw new Error('quarter must be an integer between 1 and 4');
  }

  const numericAmount = roundCurrency(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('amount must be greater than zero');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      payment: null
    };
  }

  const paymentId = randomUUID();
  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('paymentId', sql.UniqueIdentifier, paymentId);
  request.input('userId', sql.NVarChar(128), userId);
  request.input('taxYear', sql.Int, Number(taxYear));
  request.input('quarter', sql.Int, numericQuarter);
  request.input('amount', sql.Decimal(18, 2), numericAmount);
  request.input('datePaid', sql.Date, toIsoDate(datePaid) || new Date().toISOString().slice(0, 10));
  request.input('paymentMethod', sql.NVarChar(80), String(paymentMethod || 'unknown').trim() || 'unknown');
  const result = await request.query(`
    INSERT INTO accounting.estimated_tax_payments (
      estimated_tax_payment_id,
      user_id,
      tax_year,
      quarter,
      amount,
      date_paid,
      payment_method
    ) VALUES (
      @paymentId,
      @userId,
      @taxYear,
      @quarter,
      @amount,
      @datePaid,
      @paymentMethod
    );

    SELECT
      estimated_tax_payment_id,
      tax_year,
      quarter,
      amount,
      date_paid,
      payment_method,
      created_at,
      updated_at
    FROM accounting.estimated_tax_payments
    WHERE estimated_tax_payment_id = @paymentId;
  `);

  return {
    ok: true,
    status: 'ready',
    payment: mapEstimatedTaxPaymentRow(result.recordset?.[0] || {
      estimated_tax_payment_id: paymentId,
      tax_year: Number(taxYear),
      quarter: numericQuarter,
      amount: numericAmount,
      date_paid: toIsoDate(datePaid) || new Date().toISOString().slice(0, 10),
      payment_method: paymentMethod || 'unknown',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  };
}

export async function listEstimatedTaxPaymentsFromAzure({ userId, taxYear } = {}) {
  if (!userId) {
    throw new Error('userId is required to list estimated tax payments');
  }

  if (!Number.isInteger(Number(taxYear))) {
    throw new Error('taxYear is required to list estimated tax payments');
  }

  if (!isAzureSqlConfigured()) {
    return {
      ok: true,
      status: 'not_configured',
      payments: []
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('taxYear', sql.Int, Number(taxYear));
  const result = await request.query(`
    SELECT
      estimated_tax_payment_id,
      tax_year,
      quarter,
      amount,
      date_paid,
      payment_method,
      created_at,
      updated_at
    FROM accounting.estimated_tax_payments
    WHERE user_id = @userId
      AND tax_year = @taxYear
    ORDER BY quarter ASC, date_paid ASC, created_at ASC;
  `);

  return {
    ok: true,
    status: 'ready',
    payments: (result.recordset || []).map(mapEstimatedTaxPaymentRow)
  };
}