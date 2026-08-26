import { randomUUID } from 'crypto';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  DEFAULT_CHART_OF_ACCOUNTS_VERSION,
  getDefaultChartAccountByCode
} from '../../src/shared/chartOfAccounts.js';
import { getAzureSqlModule, getAzureSqlPool, isAzureSqlConfigured } from './azureSqlClient.js';
import { ensureAzureChartOfAccounts } from './ledgerStore.js';

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function safeParseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeDateOnly(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function normalizeDateTime(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function buildNotConfiguredResult(payload = {}) {
  return {
    ok: true,
    status: 'not_configured',
    ...payload
  };
}

function mapBookkeepingAccountRow(row) {
  return {
    id: row.account_code,
    code: row.account_code,
    name: row.account_name,
    type: row.account_type,
    subtype: row.account_subtype || null,
    isActive: Boolean(row.is_active),
    createdAt: normalizeDateTime(row.created_at),
    updatedAt: normalizeDateTime(row.updated_at),
    chartVersion: row.chart_version || DEFAULT_CHART_OF_ACCOUNTS_VERSION
  };
}

function mapBookkeepingPropertyRow(row) {
  const metadata = safeParseJson(row.metadata_json) || {};
  return {
    id: row.property_ref,
    name: row.property_name,
    propertyName: row.property_name,
    address: row.address || '',
    state: row.state || null,
    purchaseDate: normalizeDateOnly(row.purchase_date),
    purchasePrice: roundCurrency(row.purchase_price),
    landValue: roundCurrency(row.land_value),
    improvementValue: roundCurrency(row.improvement_value),
    description: row.description || 'Residential Rental Property',
    usefulLifeMonths: Number(row.useful_life_months || 330),
    fairRentalDays: Number(row.fair_rental_days || 365),
    personalUseDays: Number(row.personal_use_days || 0),
    createdAt: normalizeDateTime(row.created_at),
    updatedAt: normalizeDateTime(row.updated_at),
    ...metadata
  };
}

function mapBookkeepingVendorRow(row) {
  const metadata = safeParseJson(row.metadata_json) || {};
  return {
    id: row.vendor_ref,
    name: row.vendor_name,
    vendorType: row.vendor_type || 'unknown',
    ein: row.ein || null,
    ssnLast4: row.ssn_last4 || null,
    address: row.address || null,
    city: row.city || null,
    state: row.state || null,
    zip: row.zip || null,
    email: row.email || null,
    phone: row.phone || null,
    w9OnFile: Boolean(row.w9_on_file),
    w9Date: normalizeDateOnly(row.w9_date),
    notes: row.notes || '',
    createdAt: normalizeDateTime(row.created_at),
    updatedAt: normalizeDateTime(row.updated_at),
    ...metadata
  };
}

async function mergeChartAccount(pool, sql, account) {
  const request = pool.request();
  request.input('accountCode', sql.NVarChar(20), account.code);
  request.input('accountName', sql.NVarChar(255), account.name);
  request.input('accountType', sql.NVarChar(40), account.type);
  request.input('accountSubtype', sql.NVarChar(80), account.subtype || null);
  request.input('isActive', sql.Bit, account.isActive === false ? 0 : 1);
  request.input('chartVersion', sql.NVarChar(32), DEFAULT_CHART_OF_ACCOUNTS_VERSION);
  await request.query(`
    MERGE accounting.accounts AS target
    USING (SELECT @accountCode AS account_code) AS source
    ON target.account_code = source.account_code
    WHEN MATCHED THEN UPDATE SET
      account_name = @accountName,
      account_type = @accountType,
      account_subtype = @accountSubtype,
      is_active = @isActive,
      chart_version = @chartVersion,
      updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (
      account_code,
      account_name,
      account_type,
      account_subtype,
      is_active,
      chart_version
    ) VALUES (
      @accountCode,
      @accountName,
      @accountType,
      @accountSubtype,
      @isActive,
      @chartVersion
    );
  `);
}

async function upsertBookkeepingAccountRow(pool, sql, userId, account) {
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('accountCode', sql.NVarChar(20), account.code);
  request.input('accountName', sql.NVarChar(255), account.name);
  request.input('accountType', sql.NVarChar(40), account.type);
  request.input('accountSubtype', sql.NVarChar(80), account.subtype || null);
  request.input('isActive', sql.Bit, account.isActive === false ? 0 : 1);
  await request.query(`
    MERGE accounting.bookkeeping_accounts AS target
    USING (SELECT @userId AS user_id, @accountCode AS account_code) AS source
    ON target.user_id = source.user_id
       AND target.account_code = source.account_code
    WHEN MATCHED THEN UPDATE SET
      account_name = @accountName,
      account_type = @accountType,
      account_subtype = @accountSubtype,
      is_active = @isActive,
      updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (
      user_id,
      account_code,
      account_name,
      account_type,
      account_subtype,
      is_active
    ) VALUES (
      @userId,
      @accountCode,
      @accountName,
      @accountType,
      @accountSubtype,
      @isActive
    );
  `);
}

export async function isBookkeepingInitializedInAzure({ userId } = {}) {
  if (!userId) {
    throw new Error('userId is required to check bookkeeping initialization');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ initialized: false });
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  const result = await request.query(`
    SELECT COUNT(1) AS account_count
    FROM accounting.bookkeeping_accounts
    WHERE user_id = @userId
  `);
  const accountCount = Number(result.recordset?.[0]?.account_count || 0);
  return {
    ok: true,
    status: 'ready',
    initialized: accountCount > 0,
    accountCount
  };
}

export async function ensureBookkeepingInitializedInAzure({ userId } = {}) {
  if (!userId) {
    throw new Error('userId is required to initialize bookkeeping metadata');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ initialized: false, seededAccounts: 0 });
  }

  await ensureAzureChartOfAccounts();
  const status = await isBookkeepingInitializedInAzure({ userId });
  if (status.initialized) {
    return {
      ok: true,
      status: 'ready',
      initialized: true,
      alreadyInitialized: true,
      seededAccounts: status.accountCount || 0
    };
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  for (const account of DEFAULT_CHART_OF_ACCOUNTS) {
    await upsertBookkeepingAccountRow(pool, sql, userId, account);
  }

  return {
    ok: true,
    status: 'ready',
    initialized: true,
    alreadyInitialized: false,
    seededAccounts: DEFAULT_CHART_OF_ACCOUNTS.length
  };
}

export async function listBookkeepingAccountsFromAzure({ userId, includeInactive = false } = {}) {
  if (!userId) {
    throw new Error('userId is required to list bookkeeping accounts');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ accounts: [] });
  }

  await ensureBookkeepingInitializedInAzure({ userId });
  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('includeInactive', sql.Bit, includeInactive ? 1 : 0);
  const result = await request.query(`
    SELECT
      ba.account_code,
      ba.account_name,
      ba.account_type,
      ba.account_subtype,
      ba.is_active,
      ba.created_at,
      ba.updated_at,
      a.chart_version
    FROM accounting.bookkeeping_accounts ba
    LEFT JOIN accounting.accounts a
      ON a.account_code = ba.account_code
    WHERE ba.user_id = @userId
      AND (@includeInactive = 1 OR ba.is_active = 1)
    ORDER BY ba.account_code ASC
  `);
  return {
    ok: true,
    status: 'ready',
    accounts: (result.recordset || []).map(mapBookkeepingAccountRow)
  };
}

export async function getBookkeepingAccountFromAzure({ userId, accountCode } = {}) {
  if (!userId || !accountCode) {
    throw new Error('userId and accountCode are required to fetch a bookkeeping account');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ account: null });
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('accountCode', sql.NVarChar(20), accountCode);
  const result = await request.query(`
    SELECT TOP 1
      ba.account_code,
      ba.account_name,
      ba.account_type,
      ba.account_subtype,
      ba.is_active,
      ba.created_at,
      ba.updated_at,
      a.chart_version
    FROM accounting.bookkeeping_accounts ba
    LEFT JOIN accounting.accounts a
      ON a.account_code = ba.account_code
    WHERE ba.user_id = @userId
      AND ba.account_code = @accountCode
  `);
  return {
    ok: true,
    status: 'ready',
    account: result.recordset?.[0] ? mapBookkeepingAccountRow(result.recordset[0]) : null
  };
}

export async function upsertBookkeepingAccountInAzure({
  userId,
  code,
  name,
  type,
  subtype = null,
  isActive = true
} = {}) {
  if (!userId || !code || !name || !type) {
    throw new Error('userId, code, name, and type are required to save a bookkeeping account');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ account: null });
  }

  await ensureAzureChartOfAccounts();
  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const account = { code, name, type, subtype, isActive };
  await mergeChartAccount(pool, sql, account);
  await upsertBookkeepingAccountRow(pool, sql, userId, account);
  return getBookkeepingAccountFromAzure({ userId, accountCode: code });
}

export async function listBookkeepingPropertiesFromAzure({ userId } = {}) {
  if (!userId) {
    throw new Error('userId is required to list bookkeeping properties');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ properties: [] });
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  const result = await request.query(`
    SELECT
      property_ref,
      property_name,
      address,
      state,
      purchase_date,
      purchase_price,
      land_value,
      improvement_value,
      description,
      useful_life_months,
      fair_rental_days,
      personal_use_days,
      metadata_json,
      created_at,
      updated_at
    FROM accounting.bookkeeping_properties
    WHERE user_id = @userId
    ORDER BY property_name ASC, property_ref ASC
  `);
  return {
    ok: true,
    status: 'ready',
    properties: (result.recordset || []).map(mapBookkeepingPropertyRow)
  };
}

export async function upsertBookkeepingPropertyInAzure({
  userId,
  id = null,
  name,
  address = '',
  state = null,
  purchaseDate = null,
  purchasePrice = 0,
  landValue = 0,
  improvementValue = 0,
  description = 'Residential Rental Property',
  usefulLifeMonths = 330,
  fairRentalDays = 365,
  personalUseDays = 0,
  metadata = {}
} = {}) {
  if (!userId || (!name && !address)) {
    throw new Error('userId and a property name or address are required to save a bookkeeping property');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ property: null });
  }

  const propertyRef = id || randomUUID();
  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyRef', sql.NVarChar(128), propertyRef);
  request.input('propertyName', sql.NVarChar(255), name || address);
  request.input('address', sql.NVarChar(255), address || null);
  request.input('state', sql.NVarChar(32), state || null);
  request.input('purchaseDate', sql.Date, purchaseDate || null);
  request.input('purchasePrice', sql.Decimal(18, 2), roundCurrency(purchasePrice));
  request.input('landValue', sql.Decimal(18, 2), roundCurrency(landValue));
  request.input('improvementValue', sql.Decimal(18, 2), roundCurrency(improvementValue));
  request.input('description', sql.NVarChar(255), description || 'Residential Rental Property');
  request.input('usefulLifeMonths', sql.Int, Number(usefulLifeMonths || 330));
  request.input('fairRentalDays', sql.Int, Number(fairRentalDays || 365));
  request.input('personalUseDays', sql.Int, Number(personalUseDays || 0));
  request.input('metadataJson', sql.NVarChar(sql.MAX), JSON.stringify(metadata || {}));
  await request.query(`
    MERGE accounting.bookkeeping_properties AS target
    USING (SELECT @userId AS user_id, @propertyRef AS property_ref) AS source
    ON target.user_id = source.user_id
       AND target.property_ref = source.property_ref
    WHEN MATCHED THEN UPDATE SET
      property_name = @propertyName,
      address = @address,
      state = @state,
      purchase_date = @purchaseDate,
      purchase_price = @purchasePrice,
      land_value = @landValue,
      improvement_value = @improvementValue,
      description = @description,
      useful_life_months = @usefulLifeMonths,
      fair_rental_days = @fairRentalDays,
      personal_use_days = @personalUseDays,
      metadata_json = @metadataJson,
      updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (
      user_id,
      property_ref,
      property_name,
      address,
      state,
      purchase_date,
      purchase_price,
      land_value,
      improvement_value,
      description,
      useful_life_months,
      fair_rental_days,
      personal_use_days,
      metadata_json
    ) VALUES (
      @userId,
      @propertyRef,
      @propertyName,
      @address,
      @state,
      @purchaseDate,
      @purchasePrice,
      @landValue,
      @improvementValue,
      @description,
      @usefulLifeMonths,
      @fairRentalDays,
      @personalUseDays,
      @metadataJson
    );
  `);

  const properties = await listBookkeepingPropertiesFromAzure({ userId });
  return {
    ok: true,
    status: 'ready',
    property: properties.properties.find((property) => property.id === propertyRef) || null
  };
}

/**
 * Merge additional key/value pairs into an existing property's metadata_json without
 * touching any other columns. Used for ATTOM enrichment (mortgage lender, AVM, etc.)
 * after the property has already been created.
 */
export async function mergeBookkeepingPropertyMetadataInAzure({ userId, propertyId, metadata = {} } = {}) {
  if (!userId || !propertyId) {
    throw new Error('userId and propertyId are required to merge property metadata');
  }
  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ property: null });
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyRef', sql.NVarChar(128), propertyId);

  const existing = await request.query(`
    SELECT metadata_json FROM accounting.bookkeeping_properties
    WHERE user_id = @userId AND property_ref = @propertyRef
  `);
  if (!existing.recordset.length) {
    const err = new Error(`Property ${propertyId} not found`);
    err.statusCode = 404;
    throw err;
  }

  const current = safeParseJson(existing.recordset[0].metadata_json) || {};
  const merged = { ...current, ...metadata };

  const request2 = pool.request();
  request2.input('userId', sql.NVarChar(128), userId);
  request2.input('propertyRef', sql.NVarChar(128), propertyId);
  request2.input('metadataJson', sql.NVarChar(sql.MAX), JSON.stringify(merged));
  await request2.query(`
    UPDATE accounting.bookkeeping_properties
    SET metadata_json = @metadataJson, updated_at = SYSUTCDATETIME()
    WHERE user_id = @userId AND property_ref = @propertyRef
  `);

  return { ok: true, status: 'ready', merged };
}

export async function patchBookkeepingPropertyUsageDaysInAzure({
  userId,
  propertyId,
  fairRentalDays,
  personalUseDays
} = {}) {
  if (!userId || !propertyId) {
    throw new Error('userId and propertyId are required to update usage days');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ property: null });
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyId', sql.NVarChar(128), propertyId);
  request.input('fairRentalDays', sql.Int, fairRentalDays == null ? null : Math.max(0, Math.min(365, Number(fairRentalDays) || 0)));
  request.input('personalUseDays', sql.Int, personalUseDays == null ? null : Math.max(0, Math.min(365, Number(personalUseDays) || 0)));
  const result = await request.query(`
    UPDATE accounting.bookkeeping_properties
    SET
      fair_rental_days = COALESCE(@fairRentalDays, fair_rental_days),
      personal_use_days = COALESCE(@personalUseDays, personal_use_days),
      updated_at = SYSUTCDATETIME()
    OUTPUT INSERTED.property_ref
    WHERE user_id = @userId
      AND property_ref = @propertyId
  `);

  if (!result.recordset?.[0]?.property_ref) {
    const error = new Error('Property not found');
    error.statusCode = 404;
    throw error;
  }

  const properties = await listBookkeepingPropertiesFromAzure({ userId });
  return {
    ok: true,
    status: 'ready',
    property: properties.properties.find((property) => property.id === propertyId) || null
  };
}

export async function deleteBookkeepingPropertyFromAzure({ userId, propertyId } = {}) {
  if (!userId || !propertyId) {
    throw new Error('userId and propertyId are required to delete a bookkeeping property');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ deleted: false, propertyId });
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('propertyId', sql.NVarChar(128), propertyId);
  const result = await request.query(`
    DELETE FROM accounting.bookkeeping_properties
    OUTPUT DELETED.property_ref
    WHERE user_id = @userId
      AND property_ref = @propertyId
  `);

  if (!result.recordset?.[0]?.property_ref) {
    const error = new Error('Property not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    ok: true,
    status: 'ready',
    deleted: true,
    propertyId
  };
}

export async function listBookkeepingVendorsFromAzure({ userId } = {}) {
  if (!userId) {
    throw new Error('userId is required to list bookkeeping vendors');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ vendors: [] });
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  const result = await request.query(`
    SELECT
      vendor_ref,
      vendor_name,
      vendor_type,
      ein,
      ssn_last4,
      address,
      city,
      state,
      zip,
      email,
      phone,
      w9_on_file,
      w9_date,
      notes,
      metadata_json,
      created_at,
      updated_at
    FROM accounting.bookkeeping_vendors
    WHERE user_id = @userId
    ORDER BY vendor_name ASC, vendor_ref ASC
  `);
  return {
    ok: true,
    status: 'ready',
    vendors: (result.recordset || []).map(mapBookkeepingVendorRow)
  };
}

export async function upsertBookkeepingVendorInAzure({
  userId,
  id = null,
  name,
  vendorType = 'unknown',
  ein = null,
  ssn = null,
  ssnLast4 = null,
  address = null,
  city = null,
  state = null,
  zip = null,
  email = null,
  phone = null,
  w9OnFile = false,
  w9Date = null,
  notes = '',
  metadata = {}
} = {}) {
  if (!userId || !name) {
    throw new Error('userId and name are required to save a bookkeeping vendor');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ vendor: null });
  }

  const vendors = await listBookkeepingVendorsFromAzure({ userId });
  const existingVendor = id
    ? vendors.vendors.find((vendor) => vendor.id === id)
    : vendors.vendors.find((vendor) => vendor.name.toLowerCase() === String(name).trim().toLowerCase());
  const vendorRef = existingVendor?.id || id || randomUUID();
  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('vendorRef', sql.NVarChar(128), vendorRef);
  request.input('vendorName', sql.NVarChar(255), name);
  request.input('vendorType', sql.NVarChar(64), vendorType || 'unknown');
  request.input('ein', sql.NVarChar(32), ein || null);
  request.input('ssnLast4', sql.NVarChar(8), ssn ? String(ssn).slice(-4) : ssnLast4 || null);
  request.input('address', sql.NVarChar(255), address || null);
  request.input('city', sql.NVarChar(128), city || null);
  request.input('state', sql.NVarChar(32), state || null);
  request.input('zip', sql.NVarChar(32), zip || null);
  request.input('email', sql.NVarChar(255), email || null);
  request.input('phone', sql.NVarChar(64), phone || null);
  request.input('w9OnFile', sql.Bit, w9OnFile ? 1 : 0);
  request.input('w9Date', sql.Date, w9Date || null);
  request.input('notes', sql.NVarChar(1000), notes || '');
  request.input('metadataJson', sql.NVarChar(sql.MAX), JSON.stringify(metadata || {}));
  await request.query(`
    MERGE accounting.bookkeeping_vendors AS target
    USING (SELECT @userId AS user_id, @vendorRef AS vendor_ref) AS source
    ON target.user_id = source.user_id
       AND target.vendor_ref = source.vendor_ref
    WHEN MATCHED THEN UPDATE SET
      vendor_name = @vendorName,
      vendor_type = @vendorType,
      ein = @ein,
      ssn_last4 = @ssnLast4,
      address = @address,
      city = @city,
      state = @state,
      zip = @zip,
      email = @email,
      phone = @phone,
      w9_on_file = @w9OnFile,
      w9_date = @w9Date,
      notes = @notes,
      metadata_json = @metadataJson,
      updated_at = SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT (
      user_id,
      vendor_ref,
      vendor_name,
      vendor_type,
      ein,
      ssn_last4,
      address,
      city,
      state,
      zip,
      email,
      phone,
      w9_on_file,
      w9_date,
      notes,
      metadata_json
    ) VALUES (
      @userId,
      @vendorRef,
      @vendorName,
      @vendorType,
      @ein,
      @ssnLast4,
      @address,
      @city,
      @state,
      @zip,
      @email,
      @phone,
      @w9OnFile,
      @w9Date,
      @notes,
      @metadataJson
    );
  `);

  const updated = await listBookkeepingVendorsFromAzure({ userId });
  return {
    ok: true,
    status: 'ready',
    vendor: updated.vendors.find((vendor) => vendor.id === vendorRef) || null
  };
}

export async function deleteBookkeepingVendorFromAzure({ userId, vendorId } = {}) {
  if (!userId || !vendorId) {
    throw new Error('userId and vendorId are required to delete a bookkeeping vendor');
  }

  if (!isAzureSqlConfigured()) {
    return buildNotConfiguredResult({ deleted: false });
  }

  const sql = await getAzureSqlModule();
  const pool = await getAzureSqlPool();
  const request = pool.request();
  request.input('userId', sql.NVarChar(128), userId);
  request.input('vendorId', sql.NVarChar(128), vendorId);
  const result = await request.query(`
    DELETE FROM accounting.bookkeeping_vendors
    OUTPUT DELETED.vendor_ref
    WHERE user_id = @userId
      AND vendor_ref = @vendorId
  `);
  return {
    ok: true,
    status: 'ready',
    deleted: Boolean(result.recordset?.[0]?.vendor_ref)
  };
}

export function resolveBookkeepingAccountName(code, fallbackName = null) {
  return fallbackName || getDefaultChartAccountByCode(code)?.name || code;
}