// Snowflake Data Integration for Real Estate Property Search
// Uses RSA Key Pair authentication for secure access
// Requires: SNOWFLAKE_ACCOUNT, SNOWFLAKE_USERNAME, SNOWFLAKE_WAREHOUSE, SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA
import 'dotenv/config';
import snowflake from 'snowflake-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration from environment
const SNOWFLAKE_CONFIG = {
  account: process.env.SNOWFLAKE_ACCOUNT || '',
  username: process.env.SNOWFLAKE_USERNAME || '',
  warehouse: process.env.SNOWFLAKE_WAREHOUSE || '',
  database: process.env.SNOWFLAKE_DATABASE || '',
  schema: process.env.SNOWFLAKE_SCHEMA || 'PUBLIC',
};

// ============================================
// FULL-DATASET COMPATIBILITY LAYER
// ============================================
// The sample database (PREMIUMMULTICLASS) uses UPPERCASE columns and table names like "Property".
// The full dataset (REDISTRIBUTE_MULTICLASS.MKT_MULTICLASS) uses lowercase columns and 
// table names like RED_PROPERTY. This layer transparently bridges the two so all existing
// queries continue to work unchanged.
const USE_FULL_DATASET = SNOWFLAKE_CONFIG.schema === 'MKT_MULTICLASS' || 
                          SNOWFLAKE_CONFIG.database === 'REDISTRIBUTE_MULTICLASS';

// Table name mapping: sample → full dataset
const TABLE_MAP = {
  '"Property"': 'RED_PROPERTY',
  '"Media"': 'RED_MEDIA',
  '"BusinessHistory"': 'RED_BUSINESSHISTORY',
  '"OpenHouse"': 'RED_OPENHOUSE',
  '"PropertyRooms"': 'RED_PROPERTYROOMS',
  '"PropertyUnitTypes"': 'RED_PROPERTYUNITTYPES',
  '"PropertyGreenVerification"': 'RED_PROPERTYGREENVERIFICATION',
  '"PropertyPowerProduction"': 'RED_PROPERTYPOWERPRODUCTION',
  '"AccessoryDwellingUnits"': 'RED_ACCESSORYDWELLINGUNITS',
};

/**
 * Rewrite SQL for the full dataset:
 * 1. Replace table names ("Property" → RED_PROPERTY)
 * 2. Lowercase all double-quoted identifiers ("LISTPRICE" → "listprice")
 *    EXCEPT aliases (AS "X") which we leave alone since they set the output key
 */
function rewriteSqlForFullDataset(sql) {
  if (!USE_FULL_DATASET) return sql;
  
  // Step 1: Replace table names
  let rewritten = sql;
  for (const [sample, full] of Object.entries(TABLE_MAP)) {
    // Match the table name with word boundaries to avoid partial replacements
    // Handle: FROM "Property", JOIN "Property", IN (SELECT ... FROM "Property" ...)
    const escaped = sample.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rewritten = rewritten.replace(new RegExp(escaped, 'g'), full);
  }
  
  // Step 2: Lowercase all double-quoted identifiers that are column references
  // We need to be careful NOT to lowercase:
  //   - String literals (inside single quotes)
  //   - AS aliases (we want output keys to stay uppercase)
  // Strategy: lowercase ALL quoted identifiers, then the result normalizer will uppercase output keys
  rewritten = rewritten.replace(/"([A-Z][A-Z0-9_]*)"/g, (match, col) => {
    return `"${col.toLowerCase()}"`;
  });
  
  return rewritten;
}

/**
 * Normalize result rows: uppercase all keys so existing code works regardless of source
 */
function normalizeRows(rows) {
  if (!USE_FULL_DATASET || !rows || rows.length === 0) return rows;
  return rows.map(row => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key.toUpperCase()] = value;
    }
    return normalized;
  });
}

// Path to RSA private key
const PRIVATE_KEY_PATH = process.env.SNOWFLAKE_PRIVATE_KEY_PATH || 
  path.join(__dirname, '..', '.snowflake', 'rsa_key.p8');

// Connection pool
let connectionPool = null;

/**
 * Get the private key for RSA authentication
 */
function getPrivateKey() {
  try {
    const privateKey = fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8');
    return privateKey;
  } catch (error) {
    console.error('Failed to read Snowflake private key:', error.message);
    throw new Error(`Cannot read RSA private key at ${PRIVATE_KEY_PATH}. Run setup first.`);
  }
}

/**
 * Create a new Snowflake connection with RSA key pair authentication
 */
function createConnection() {
  const privateKey = getPrivateKey();
  
  return snowflake.createConnection({
    account: SNOWFLAKE_CONFIG.account,
    username: SNOWFLAKE_CONFIG.username,
    authenticator: 'SNOWFLAKE_JWT',
    privateKey: privateKey,
    warehouse: SNOWFLAKE_CONFIG.warehouse,
    database: SNOWFLAKE_CONFIG.database,
    schema: SNOWFLAKE_CONFIG.schema,
    clientSessionKeepAlive: true,
    clientSessionKeepAliveHeartbeatFrequency: 3600,
  });
}

/**
 * Connect to Snowflake (with connection reuse)
 */
async function connect() {
  return new Promise((resolve, reject) => {
    if (connectionPool && connectionPool.isUp()) {
      resolve(connectionPool);
      return;
    }

    const connection = createConnection();
    
    connection.connect((err, conn) => {
      if (err) {
        console.error('Snowflake connection failed:', err.message);
        reject(err);
      } else {
        console.log('✅ Connected to Snowflake successfully');
        connectionPool = conn;
        resolve(conn);
      }
    });
  });
}

/**
 * Execute a SQL query and return results
 * @param {string} sqlText - SQL query to execute
 * @param {Array} binds - Optional parameter bindings
 * @returns {Promise<Array>} - Query results
 */
async function executeQuery(sqlText, binds = []) {
  const connection = await connect();
  const rewrittenSql = rewriteSqlForFullDataset(sqlText);
  
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: rewrittenSql,
      binds,
      complete: (err, stmt, rows) => {
        if (err) {
          console.error('Snowflake query failed:', err.message);
          reject(err);
        } else {
          resolve(normalizeRows(rows || []));
        }
      }
    });
  });
}

/**
 * Execute a SQL query with streaming for large results
 * @param {string} sqlText - SQL query to execute
 * @param {Function} onRow - Callback for each row
 * @returns {Promise<void>}
 */
async function executeQueryStream(sqlText, onRow) {
  const connection = await connect();
  const rewrittenSql = rewriteSqlForFullDataset(sqlText);
  
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: rewrittenSql,
      streamResult: true,
      complete: (err, stmt) => {
        if (err) {
          reject(err);
          return;
        }
        
        const stream = stmt.streamRows();
        stream.on('data', onRow);
        stream.on('end', resolve);
        stream.on('error', reject);
      }
    });
  });
}

// ============================================
// PROPERTY SEARCH FUNCTIONS
// ============================================

/**
 * Search properties by location (city, state, zip)
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} - Property listings
 */
async function searchPropertiesByLocation({ city, state, zip, limit = 50 }) {
  let whereClause = [];
  let binds = [];
  
  if (city) {
    whereClause.push('UPPER(city) = UPPER(?)');
    binds.push(city);
  }
  if (state) {
    whereClause.push('UPPER(state) = UPPER(?)');
    binds.push(state);
  }
  if (zip) {
    whereClause.push('zip_code = ?');
    binds.push(zip);
  }
  
  const sql = `
    SELECT *
    FROM properties
    ${whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : ''}
    LIMIT ?
  `;
  binds.push(limit);
  
  return executeQuery(sql, binds);
}

/**
 * Search properties by price range
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} - Property listings
 */
async function searchPropertiesByPrice({ minPrice, maxPrice, propertyType, limit = 50 }) {
  let whereClause = [];
  let binds = [];
  
  if (minPrice) {
    whereClause.push('list_price >= ?');
    binds.push(minPrice);
  }
  if (maxPrice) {
    whereClause.push('list_price <= ?');
    binds.push(maxPrice);
  }
  if (propertyType) {
    whereClause.push('UPPER(property_type) = UPPER(?)');
    binds.push(propertyType);
  }
  
  const sql = `
    SELECT *
    FROM properties
    ${whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : ''}
    ORDER BY list_price ASC
    LIMIT ?
  `;
  binds.push(limit);
  
  return executeQuery(sql, binds);
}

/**
 * Search properties with multiple filters
 * @param {Object} filters - All search filters
 * @returns {Promise<Array>} - Property listings
 */
async function searchProperties({
  city,
  state,
  zip,
  minPrice,
  maxPrice,
  minBeds,
  maxBeds,
  minBaths,
  maxBaths,
  minSqft,
  maxSqft,
  propertyType,
  yearBuiltMin,
  yearBuiltMax,
  limit = 50,
  offset = 0,
  orderBy = 'list_price',
  orderDir = 'ASC'
}) {
  let whereClause = [];
  let binds = [];
  
  // Location filters
  if (city) {
    whereClause.push('UPPER(city) = UPPER(?)');
    binds.push(city);
  }
  if (state) {
    whereClause.push('UPPER(state) = UPPER(?)');
    binds.push(state);
  }
  if (zip) {
    whereClause.push('zip_code = ?');
    binds.push(zip);
  }
  
  // Price filters
  if (minPrice) {
    whereClause.push('list_price >= ?');
    binds.push(minPrice);
  }
  if (maxPrice) {
    whereClause.push('list_price <= ?');
    binds.push(maxPrice);
  }
  
  // Bedroom filters
  if (minBeds) {
    whereClause.push('bedrooms >= ?');
    binds.push(minBeds);
  }
  if (maxBeds) {
    whereClause.push('bedrooms <= ?');
    binds.push(maxBeds);
  }
  
  // Bathroom filters
  if (minBaths) {
    whereClause.push('bathrooms >= ?');
    binds.push(minBaths);
  }
  if (maxBaths) {
    whereClause.push('bathrooms <= ?');
    binds.push(maxBaths);
  }
  
  // Square footage filters
  if (minSqft) {
    whereClause.push('square_feet >= ?');
    binds.push(minSqft);
  }
  if (maxSqft) {
    whereClause.push('square_feet <= ?');
    binds.push(maxSqft);
  }
  
  // Property type
  if (propertyType) {
    whereClause.push('UPPER(property_type) = UPPER(?)');
    binds.push(propertyType);
  }
  
  // Year built filters
  if (yearBuiltMin) {
    whereClause.push('year_built >= ?');
    binds.push(yearBuiltMin);
  }
  if (yearBuiltMax) {
    whereClause.push('year_built <= ?');
    binds.push(yearBuiltMax);
  }
  
  // Validate orderBy to prevent SQL injection
  const allowedOrderBy = ['list_price', 'bedrooms', 'bathrooms', 'square_feet', 'year_built', 'created_at'];
  const safeOrderBy = allowedOrderBy.includes(orderBy) ? orderBy : 'list_price';
  const safeOrderDir = orderDir.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  
  const sql = `
    SELECT *
    FROM properties
    ${whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : ''}
    ORDER BY ${safeOrderBy} ${safeOrderDir}
    LIMIT ?
    OFFSET ?
  `;
  binds.push(limit, offset);
  
  return executeQuery(sql, binds);
}

/**
 * Get property details by ID
 * @param {string} propertyId - Property ID
 * @returns {Promise<Object|null>} - Property details
 */
async function getPropertyById(propertyId) {
  const sql = `SELECT * FROM properties WHERE property_id = ?`;
  const results = await executeQuery(sql, [propertyId]);
  return results[0] || null;
}

/**
 * Get property details by address
 * @param {string} address - Full street address
 * @param {string} city - City
 * @param {string} state - State
 * @returns {Promise<Object|null>} - Property details
 */
async function getPropertyByAddress(address, city, state) {
  const sql = `
    SELECT * FROM properties 
    WHERE UPPER(address) LIKE UPPER(?)
    AND UPPER(city) = UPPER(?)
    AND UPPER(state) = UPPER(?)
    LIMIT 1
  `;
  const results = await executeQuery(sql, [`%${address}%`, city, state]);
  return results[0] || null;
}

/**
 * Get properties within a geographic bounding box
 * @param {Object} bounds - Bounding box coordinates
 * @returns {Promise<Array>} - Properties within bounds
 */
async function searchPropertiesInBounds({ north, south, east, west, limit = 100 }) {
  const sql = `
    SELECT * FROM properties
    WHERE latitude BETWEEN ? AND ?
    AND longitude BETWEEN ? AND ?
    LIMIT ?
  `;
  return executeQuery(sql, [south, north, west, east, limit]);
}

/**
 * Get property count matching filters
 * @param {Object} filters - Search filters
 * @returns {Promise<number>} - Total count
 */
async function getPropertyCount(filters = {}) {
  // Build same WHERE clause as searchProperties but just count
  let whereClause = [];
  let binds = [];
  
  if (filters.city) {
    whereClause.push('UPPER(city) = UPPER(?)');
    binds.push(filters.city);
  }
  if (filters.state) {
    whereClause.push('UPPER(state) = UPPER(?)');
    binds.push(filters.state);
  }
  if (filters.zip) {
    whereClause.push('zip_code = ?');
    binds.push(filters.zip);
  }
  if (filters.minPrice) {
    whereClause.push('list_price >= ?');
    binds.push(filters.minPrice);
  }
  if (filters.maxPrice) {
    whereClause.push('list_price <= ?');
    binds.push(filters.maxPrice);
  }
  
  const sql = `
    SELECT COUNT(*) as total
    FROM properties
    ${whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : ''}
  `;
  
  const results = await executeQuery(sql, binds);
  return results[0]?.TOTAL || 0;
}

/**
 * Test the Snowflake connection
 * @returns {Promise<Object>} - Connection status
 */
async function testConnection() {
  try {
    const result = await executeQuery('SELECT CURRENT_TIMESTAMP() as now, CURRENT_DATABASE() as db, CURRENT_SCHEMA() as schema');
    return {
      connected: true,
      timestamp: result[0]?.NOW,
      database: result[0]?.DB,
      schema: result[0]?.SCHEMA
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message
    };
  }
}

/**
 * List available tables in the current schema
 * @returns {Promise<Array>} - List of table names
 */
async function listTables() {
  const sql = `SHOW TABLES IN SCHEMA`;
  return executeQuery(sql);
}

/**
 * Describe a table's columns
 * @param {string} tableName - Table name
 * @returns {Promise<Array>} - Column definitions
 */
async function describeTable(tableName) {
  const sql = `DESCRIBE TABLE ${tableName}`;
  return executeQuery(sql);
}

/**
 * Close the Snowflake connection
 */
async function disconnect() {
  if (connectionPool) {
    return new Promise((resolve) => {
      connectionPool.destroy((err) => {
        if (err) {
          console.error('Error closing Snowflake connection:', err.message);
        } else {
          console.log('Snowflake connection closed');
        }
        connectionPool = null;
        resolve();
      });
    });
  }
}

// ============================================
// MLS-SPECIFIC PROPERTY FUNCTIONS
// ============================================

/**
 * Search MLS properties with filters
 * @param {Object} filters - Search filters
 * @returns {Promise<Array>} - Property listings
 */
async function searchMLSProperties({
  city,
  state,
  zip,
  minPrice,
  maxPrice,
  minBeds,
  maxBeds,
  minBaths,
  maxBaths,
  propertyType,
  propertySubtype,
  status = 'Active',
  minSqft,
  maxSqft,
  minYearBuilt,
  maxYearBuilt,
  minLotSize,
  maxLotSize,
  limit = 50,
  offset = 0
}) {
  let whereClause = [];
  let binds = [];
  
  // Location filters
  if (city) {
    whereClause.push('UPPER("CITY") = UPPER(?)');
    binds.push(city);
  }
  if (state) {
    whereClause.push('UPPER("STATEORPROVINCE") = UPPER(?)');
    binds.push(state);
  }
  if (zip) {
    whereClause.push('"POSTALCODE" = ?');
    binds.push(zip);
  }
  
  // Price filters
  if (minPrice) {
    whereClause.push('"LISTPRICE" >= ?');
    binds.push(minPrice);
  }
  if (maxPrice) {
    whereClause.push('"LISTPRICE" <= ?');
    binds.push(maxPrice);
  }
  
  // Bedroom filters
  if (minBeds) {
    whereClause.push('"BEDROOMSTOTAL" >= ?');
    binds.push(minBeds);
  }
  if (maxBeds) {
    whereClause.push('"BEDROOMSTOTAL" <= ?');
    binds.push(maxBeds);
  }
  
  // Bathroom filters
  if (minBaths) {
    whereClause.push('"BATHROOMSTOTALINTEGER" >= ?');
    binds.push(minBaths);
  }
  if (maxBaths) {
    whereClause.push('"BATHROOMSTOTALINTEGER" <= ?');
    binds.push(maxBaths);
  }
  
  // Property type (e.g. Residential, Land, Commercial Sale, Commercial Lease, Residential Lease)
  if (propertyType) {
    whereClause.push('UPPER("PROPERTYTYPE") = UPPER(?)');
    binds.push(propertyType);
  }
  
  // Property subtype (e.g. Single Family Residence, Condominium, Townhouse, etc.)
  if (propertySubtype) {
    whereClause.push('UPPER("PROPERTYSUBTYPE") = UPPER(?)');
    binds.push(propertySubtype);
  }
  
  // Status filter
  if (status) {
    whereClause.push('UPPER("STANDARDSTATUS") = UPPER(?)');
    binds.push(status);
  }
  
  // Square footage filters
  if (minSqft) {
    whereClause.push('"LIVINGAREA" >= ?');
    binds.push(minSqft);
  }
  if (maxSqft) {
    whereClause.push('"LIVINGAREA" <= ?');
    binds.push(maxSqft);
  }
  
  // Year built filters
  if (minYearBuilt) {
    whereClause.push('"YEARBUILT" >= ?');
    binds.push(minYearBuilt);
  }
  if (maxYearBuilt) {
    whereClause.push('"YEARBUILT" <= ?');
    binds.push(maxYearBuilt);
  }
  
  // Lot size filters
  if (minLotSize) {
    whereClause.push('"LOTSIZEAREA" >= ?');
    binds.push(minLotSize);
  }
  if (maxLotSize) {
    whereClause.push('"LOTSIZEAREA" <= ?');
    binds.push(maxLotSize);
  }
  
  const sql = `
    SELECT 
      -- Core listing info
      "LISTINGKEY",
      "LISTINGID",
      "LISTPRICE",
      "STREETNUMBER",
      "STREETNAME",
      "STREETSUFFIX",
      "UNITNUMBER",
      "CITY",
      "STATEORPROVINCE",
      "POSTALCODE",
      "COUNTYORPARISH",
      "NEIGHBORHOOD",
      "SUBDIVISIONNAME",
      -- Property characteristics
      "BEDROOMSTOTAL",
      "BATHROOMSTOTALINTEGER",
      "BATHROOMSFULL",
      "BATHROOMSHALF",
      "LIVINGAREA",
      "LIVINGAREAUNITS",
      "LOTSIZEAREA",
      "LOTSIZEUNITS",
      "LOTSIZEDIMENSIONS",
      "YEARBUILT",
      "STORIES",
      "STORIESTOTAL",
      "GARAGESPACES",
      "GARAGEYN",
      "PARKINGTOTAL",
      -- Classification
      "PROPERTYTYPE",
      "PROPERTYSUBTYPE",
      "STANDARDSTATUS",
      "ARCHITECTURALSTYLE",
      "STRUCTURETYPE",
      "CONSTRUCTIONMATERIALS",
      "ROOF",
      "FOUNDATIONDETAILS",
      "LEVELS",
      "NEWCONSTRUCTIONYN",
      "PROPERTYCONDITION",
      -- Geo
      "LATITUDE",
      "LONGITUDE",
      -- Remarks
      "PUBLICREMARKS",
      -- Media & timing
      "PHOTOSCOUNT",
      "DAYSONMARKET",
      "MODIFICATIONTIMESTAMP",
      -- Sale data
      "CLOSEPRICE",
      "CLOSEDATE",
      "ORIGINALLISTPRICE",
      "LISTINGCONTRACTDATE",
      "ONMARKETDATE",
      "OFFMARKETDATE",
      "PRICECHANGETIMESTAMP",
      -- Financial / Investment (MultiClass)
      "CAPRATE",
      "NETOPERATINGINCOME",
      "GROSSINCOME",
      "TOTALEXPENSES",
      "TOTALACTUALRENT",
      "TOTALMONTHLYRENT",
      "OPERATINGEXPENSE",
      "GROSSMULTIPLIER",
      "VACANCYALLOWANCERATE",
      -- Tax data
      "TAXANNUALAMOUNT",
      "TAXASSESSEDVALUE",
      "TAXYEAR",
      "ZONING",
      "ZONINGDESCRIPTION",
      -- HOA / Association
      "ASSOCIATIONYN",
      "ASSOCIATIONFEE",
      "ASSOCIATIONFEEFREQUENCY",
      "ASSOCIATIONNAME",
      -- Schools
      "ELEMENTARYSCHOOL",
      "MIDDLEORJUNIORSCHOOL",
      "HIGHSCHOOL",
      "ELEMENTARYSCHOOLDISTRICT",
      "HIGHSCHOOLDISTRICT",
      -- Features
      "POOLYN",
      "FIREPLACEYN",
      "FIREPLACESTOTAL",
      "WATERFRONTYN",
      "WALKSCORE",
      -- Rental / Lease (MultiClass)
      "RENTMIN",
      "RENTMAX",
      "LEASETERM",
      "PETSALLOWED",
      "DEPOSITSECURITY",
      "AVAILABILITYDATE",
      -- Listing agent
      "LISTAGENTFULLNAME",
      "LISTOFFICENAME",
      -- Virtual tour
      "VIRTUALTOURURLUNBRANDED"
    FROM "Property"
    ${whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : ''}
    ORDER BY "MODIFICATIONTIMESTAMP" DESC
    LIMIT ?
    OFFSET ?
  `;
  binds.push(limit, offset);
  
  return executeQuery(sql, binds);
}

/**
 * Get property by listing key
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Object|null>} - Property details
 */
async function getMLSPropertyByKey(listingKey) {
  const sql = `SELECT * FROM "Property" WHERE "LISTINGKEY" = ? LIMIT 1`;
  const results = await executeQuery(sql, [listingKey]);
  return results[0] || null;
}

/**
 * Get property images/media by listing key
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Array>} - Array of media objects with URLs
 */
async function getPropertyMedia(listingKey) {
  const sql = `
    SELECT 
      "MEDIAURL",
      "MEDIACATEGORY",
      "PREFERREDPHOTOYN",
      "order",
      "IMAGESIZEDESCRIPTION",
      "LONGDESCRIPTION",
      "SHORTDESCRIPTION",
      "IMAGEHEIGHT",
      "IMAGEWIDTH"
    FROM "Media"
    WHERE "LISTINGKEY" = ?
    AND "MEDIACATEGORY" = 'Photo'
    ORDER BY "order" ASC
  `;
  return executeQuery(sql, [listingKey]);
}

/**
 * Get property with images
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Object|null>} - Property with images array
 */
async function getMLSPropertyWithImages(listingKey) {
  const [property, media] = await Promise.all([
    getMLSPropertyByKey(listingKey),
    getPropertyMedia(listingKey)
  ]);
  
  if (!property) return null;
  
  return {
    ...property,
    images: media.map(m => ({
      url: m.MEDIAURL,
      isPrimary: m.PREFERREDPHOTOYN === true,
      order: m.order,
      description: m.LONGDESCRIPTION || m.SHORTDESCRIPTION,
      width: m.IMAGEWIDTH,
      height: m.IMAGEHEIGHT
    }))
  };
}

/**
 * Search properties and include primary image
 * @param {Object} filters - Search filters
 * @returns {Promise<Array>} - Properties with primary image
 */
async function searchMLSPropertiesWithImages(filters) {
  const properties = await searchMLSProperties(filters);
  
  // Get primary images — use timeout so search isn't blocked by slow media table
  if (properties.length > 0) {
    try {
      const imageMap = await Promise.race([
        fetchPrimaryImages(properties.map(p => p.LISTINGKEY)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Image fetch timeout')), 8000))
      ]);
      return properties.map(p => ({
        ...p,
        primaryImage: imageMap[p.LISTINGKEY] || null
      }));
    } catch (e) {
      console.warn('[MLS] Image fetch skipped:', e.message);
      return properties.map(p => ({ ...p, primaryImage: null }));
    }
  }
  
  return properties;
}

/**
 * Fetch primary image URLs for a batch of listing keys
 * Uses individual lookups per key for better Snowflake performance on large tables
 */
async function fetchPrimaryImages(listingKeys) {
  const keys = listingKeys.map(k => `'${k.replace(/'/g, "''")}'`).join(',');
  const sql = `
    SELECT "LISTINGKEY", "MEDIAURL"
    FROM "Media"
    WHERE "LISTINGKEY" IN (${keys})
    AND "MEDIACATEGORY" = 'Photo'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY "LISTINGKEY" ORDER BY "PREFERREDPHOTOYN" DESC NULLS LAST, "order" ASC) = 1
  `;
  const images = await executeQuery(sql);
  const imageMap = {};
  images.forEach(img => { imageMap[img.LISTINGKEY] = img.MEDIAURL; });
  return imageMap;
}

/**
 * Get open houses for a property
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Array>} - Open house schedules
 */
async function getPropertyOpenHouses(listingKey) {
  const sql = `SELECT * FROM "OpenHouse" WHERE "LISTINGKEY" = ? ORDER BY "OPENHOUSEDATE" ASC`;
  return executeQuery(sql, [listingKey]);
}

/**
 * Get property rooms
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Array>} - Room details
 */
async function getPropertyRooms(listingKey) {
  const sql = `SELECT * FROM "PropertyRooms" WHERE "LISTINGKEY" = ?`;
  return executeQuery(sql, [listingKey]);
}

// ============================================
// RENOVATION ROI ANALYSIS FUNCTIONS
// ============================================

/**
 * Find properties that have been listed/sold multiple times (renovation candidates)
 * These are properties where we can compare before/after photos and prices
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} - Properties with multiple listings
 */
async function findRenovationCandidates({
  city,
  state,
  zipCode,
  minListings = 2,
  minPriceIncrease = 10000,
  minHoldingMonths = 6,
  maxHoldingMonths = 120,
  limit = 100
}) {
  let whereClause = [];
  let binds = [];
  
  if (city) {
    whereClause.push('UPPER("CITY") = UPPER(?)');
    binds.push(city);
  }
  if (state) {
    whereClause.push('UPPER("STATEORPROVINCE") = UPPER(?)');
    binds.push(state);
  }
  if (zipCode) {
    whereClause.push('"POSTALCODE" = ?');
    binds.push(zipCode);
  }
  
  const locationFilter = whereClause.length > 0 ? 'AND ' + whereClause.join(' AND ') : '';
  
  const sql = `
    WITH property_sales AS (
      SELECT 
        "UNPARSEDADDRESS",
        "CITY",
        "STATEORPROVINCE",
        "POSTALCODE",
        "COUNTYORPARISH",
        "LISTINGKEY",
        "LISTPRICE",
        "CLOSEPRICE",
        "ONMARKETDATE",
        "CLOSEDATE",
        "BEDROOMSTOTAL",
        "BATHROOMSTOTALINTEGER",
        "LIVINGAREA",
        "YEARBUILT",
        "PROPERTYTYPE",
        "PHOTOSCOUNT",
        "STANDARDSTATUS",
        ROW_NUMBER() OVER (
          PARTITION BY "UNPARSEDADDRESS", "CITY", "STATEORPROVINCE" 
          ORDER BY "ONMARKETDATE" ASC NULLS LAST
        ) as listing_order,
        COUNT(*) OVER (
          PARTITION BY "UNPARSEDADDRESS", "CITY", "STATEORPROVINCE"
        ) as total_listings
      FROM "Property"
      WHERE "UNPARSEDADDRESS" IS NOT NULL
      AND "CLOSEPRICE" IS NOT NULL
      AND "CLOSEPRICE" > 0
      AND "PHOTOSCOUNT" > 0
      ${locationFilter}
    ),
    paired_sales AS (
      SELECT 
        s1."UNPARSEDADDRESS" as address,
        s1."CITY" as city,
        s1."STATEORPROVINCE" as state,
        s1."POSTALCODE" as zip_code,
        s1."COUNTYORPARISH" as county,
        s1."PROPERTYTYPE" as property_type,
        s1."BEDROOMSTOTAL" as beds,
        s1."BATHROOMSTOTALINTEGER" as baths,
        s1."LIVINGAREA" as sqft,
        s1."YEARBUILT" as year_built,
        s1.total_listings,
        -- Before (earlier sale)
        s1."LISTINGKEY" as before_listing_key,
        s1."ONMARKETDATE" as before_list_date,
        s1."CLOSEDATE" as before_sale_date,
        s1."LISTPRICE" as before_list_price,
        s1."CLOSEPRICE" as before_sale_price,
        s1."PHOTOSCOUNT" as before_photo_count,
        -- After (later sale)
        s2."LISTINGKEY" as after_listing_key,
        s2."ONMARKETDATE" as after_list_date,
        s2."CLOSEDATE" as after_sale_date,
        s2."LISTPRICE" as after_list_price,
        s2."CLOSEPRICE" as after_sale_price,
        s2."PHOTOSCOUNT" as after_photo_count,
        -- Calculated metrics
        s2."CLOSEPRICE" - s1."CLOSEPRICE" as price_increase,
        ROUND((s2."CLOSEPRICE" - s1."CLOSEPRICE") / NULLIF(s1."CLOSEPRICE", 0) * 100, 2) as price_increase_pct,
        DATEDIFF('month', s1."CLOSEDATE", s2."CLOSEDATE") as holding_months
      FROM property_sales s1
      JOIN property_sales s2 
        ON s1."UNPARSEDADDRESS" = s2."UNPARSEDADDRESS"
        AND s1."CITY" = s2."CITY"
        AND s1."STATEORPROVINCE" = s2."STATEORPROVINCE"
        AND s1.listing_order = 1
        AND s2.listing_order = 2
      WHERE s1.total_listings >= ?
    )
    SELECT *
    FROM paired_sales
    WHERE holding_months >= ?
    AND holding_months <= ?
    AND before_photo_count >= 1
    AND after_photo_count >= 1
    ORDER BY price_increase_pct DESC
    LIMIT ?
  `;
  
  // Note: removed minPriceIncrease filter to show all multi-sale properties (including price decreases)
  binds.push(minListings, minHoldingMonths, maxHoldingMonths, limit);
  
  return executeQuery(sql, binds);
}

/**
 * Get all photos for multiple listings (for before/after comparison)
 * @param {string[]} listingKeys - Array of listing keys
 * @returns {Promise<Object>} - Photos grouped by listing key
 */
async function getPhotosForListings(listingKeys) {
  if (!listingKeys || listingKeys.length === 0) {
    return {};
  }
  
  const keyPlaceholders = listingKeys.map(() => '?').join(',');
  
  const sql = `
    SELECT 
      "LISTINGKEY",
      "MEDIAURL",
      "MEDIACATEGORY",
      "PREFERREDPHOTOYN",
      "order" as media_order,
      "LONGDESCRIPTION",
      "SHORTDESCRIPTION",
      "IMAGEWIDTH",
      "IMAGEHEIGHT"
    FROM "Media"
    WHERE "LISTINGKEY" IN (${keyPlaceholders})
    AND "MEDIACATEGORY" = 'Photo'
    ORDER BY "LISTINGKEY", "order" ASC
  `;
  
  const photos = await executeQuery(sql, listingKeys);
  
  // Group by listing key
  const grouped = {};
  photos.forEach(photo => {
    if (!grouped[photo.LISTINGKEY]) {
      grouped[photo.LISTINGKEY] = [];
    }
    grouped[photo.LISTINGKEY].push({
      url: photo.MEDIAURL,
      order: photo.media_order,
      isPrimary: photo.PREFERREDPHOTOYN === true,
      description: photo.LONGDESCRIPTION || photo.SHORTDESCRIPTION,
      width: photo.IMAGEWIDTH,
      height: photo.IMAGEHEIGHT
    });
  });
  
  return grouped;
}

/**
 * Get complete renovation candidate data with photos
 * @param {string} beforeListingKey - Earlier listing key
 * @param {string} afterListingKey - Later listing key
 * @returns {Promise<Object>} - Complete before/after data
 */
async function getRenovationCandidateWithPhotos(beforeListingKey, afterListingKey) {
  // Get both properties
  const [beforeProperty, afterProperty] = await Promise.all([
    getMLSPropertyByKey(beforeListingKey),
    getMLSPropertyByKey(afterListingKey)
  ]);
  
  if (!beforeProperty || !afterProperty) {
    return null;
  }
  
  // Get photos for both
  const photos = await getPhotosForListings([beforeListingKey, afterListingKey]);
  
  return {
    address: beforeProperty.UNPARSEDADDRESS || `${beforeProperty.STREETNUMBER} ${beforeProperty.STREETNAME} ${beforeProperty.STREETSUFFIX}`,
    city: beforeProperty.CITY,
    state: beforeProperty.STATEORPROVINCE,
    zipCode: beforeProperty.POSTALCODE,
    county: beforeProperty.COUNTYORPARISH,
    propertyType: beforeProperty.PROPERTYTYPE,
    beds: beforeProperty.BEDROOMSTOTAL,
    baths: beforeProperty.BATHROOMSTOTALINTEGER,
    sqft: beforeProperty.LIVINGAREA,
    yearBuilt: beforeProperty.YEARBUILT,
    before: {
      listingKey: beforeListingKey,
      listDate: beforeProperty.ONMARKETDATE,
      saleDate: beforeProperty.CLOSEDATE,
      listPrice: beforeProperty.LISTPRICE,
      salePrice: beforeProperty.CLOSEPRICE,
      daysOnMarket: beforeProperty.DAYSONMARKET,
      photos: photos[beforeListingKey] || []
    },
    after: {
      listingKey: afterListingKey,
      listDate: afterProperty.ONMARKETDATE,
      saleDate: afterProperty.CLOSEDATE,
      listPrice: afterProperty.LISTPRICE,
      salePrice: afterProperty.CLOSEPRICE,
      daysOnMarket: afterProperty.DAYSONMARKET,
      photos: photos[afterListingKey] || []
    },
    metrics: {
      priceIncrease: (afterProperty.CLOSEPRICE || 0) - (beforeProperty.CLOSEPRICE || 0),
      priceIncreasePercent: beforeProperty.CLOSEPRICE 
        ? ((afterProperty.CLOSEPRICE - beforeProperty.CLOSEPRICE) / beforeProperty.CLOSEPRICE * 100).toFixed(2)
        : null,
      holdingMonths: beforeProperty.CLOSEDATE && afterProperty.CLOSEDATE
        ? Math.round((new Date(afterProperty.CLOSEDATE) - new Date(beforeProperty.CLOSEDATE)) / (1000 * 60 * 60 * 24 * 30))
        : null
    }
  };
}

/**
 * Get renovation statistics for an area
 * @param {Object} params - Query parameters
 * @returns {Promise<Object>} - Area statistics
 */
async function getRenovationAreaStats({ city, state, zipCode }) {
  let whereClause = [];
  let binds = [];
  
  if (city) {
    whereClause.push('UPPER("CITY") = UPPER(?)');
    binds.push(city);
  }
  if (state) {
    whereClause.push('UPPER("STATEORPROVINCE") = UPPER(?)');
    binds.push(state);
  }
  if (zipCode) {
    whereClause.push('"POSTALCODE" = ?');
    binds.push(zipCode);
  }
  
  // Build WHERE clause - always need WHERE for base conditions, add location filters with AND
  const locationFilter = whereClause.length > 0 ? 'AND ' + whereClause.join(' AND ') : '';
  
  const sql = `
    WITH property_counts AS (
      SELECT 
        "UNPARSEDADDRESS",
        "CITY",
        "STATEORPROVINCE",
        "POSTALCODE",
        COUNT(*) as listing_count,
        MIN("CLOSEPRICE") as first_sale_price,
        MAX("CLOSEPRICE") as last_sale_price,
        MIN("CLOSEDATE") as first_sale_date,
        MAX("CLOSEDATE") as last_sale_date
      FROM "Property"
      WHERE "UNPARSEDADDRESS" IS NOT NULL
      AND "CLOSEPRICE" IS NOT NULL
      AND "CLOSEPRICE" > 0
      ${locationFilter}
      GROUP BY "UNPARSEDADDRESS", "CITY", "STATEORPROVINCE", "POSTALCODE"
      HAVING COUNT(*) >= 2
    )
    SELECT 
      COUNT(*) as total_renovation_candidates,
      AVG(last_sale_price - first_sale_price) as avg_price_increase,
      AVG((last_sale_price - first_sale_price) / NULLIF(first_sale_price, 0) * 100) as avg_price_increase_pct,
      MIN(last_sale_price - first_sale_price) as min_price_increase,
      MAX(last_sale_price - first_sale_price) as max_price_increase,
      AVG(DATEDIFF('month', first_sale_date, last_sale_date)) as avg_holding_months
    FROM property_counts
  `;
  
  console.log('[DEBUG] getRenovationAreaStats SQL:', sql);
  console.log('[DEBUG] binds:', binds);
  
  const results = await executeQuery(sql, binds);
  return results[0] || null;
}

/**
 * Get properties with specific price increase patterns in an area
 * Used to find comparables for specific renovation types
 * @param {Object} params - Search parameters
 * @returns {Promise<Array>} - Matching properties
 */
async function findSimilarRenovations({
  zipCode,
  minPriceIncreasePct = 10,
  maxPriceIncreasePct = 50,
  minSqft,
  maxSqft,
  propertyType,
  limit = 50
}) {
  let whereClause = ['"POSTALCODE" = ?'];
  let binds = [zipCode];
  
  if (propertyType) {
    whereClause.push('UPPER("PROPERTYTYPE") = UPPER(?)');
    binds.push(propertyType);
  }
  
  const locationFilter = whereClause.join(' AND ');
  
  const sql = `
    WITH property_sales AS (
      SELECT 
        "UNPARSEDADDRESS",
        "CITY",
        "STATEORPROVINCE",
        "POSTALCODE",
        "LISTINGKEY",
        "CLOSEPRICE",
        "CLOSEDATE",
        "LIVINGAREA",
        "PROPERTYTYPE",
        "PHOTOSCOUNT",
        ROW_NUMBER() OVER (
          PARTITION BY "UNPARSEDADDRESS" 
          ORDER BY "CLOSEDATE" ASC NULLS LAST
        ) as sale_order,
        COUNT(*) OVER (PARTITION BY "UNPARSEDADDRESS") as total_sales
      FROM "Property"
      WHERE ${locationFilter}
      AND "UNPARSEDADDRESS" IS NOT NULL
      AND "CLOSEPRICE" IS NOT NULL
      AND "CLOSEPRICE" > 0
    ),
    paired AS (
      SELECT 
        s1."UNPARSEDADDRESS" as address,
        s1."LISTINGKEY" as before_key,
        s2."LISTINGKEY" as after_key,
        s1."CLOSEPRICE" as before_price,
        s2."CLOSEPRICE" as after_price,
        s1."LIVINGAREA" as sqft,
        s1."PROPERTYTYPE" as property_type,
        ROUND((s2."CLOSEPRICE" - s1."CLOSEPRICE") / NULLIF(s1."CLOSEPRICE", 0) * 100, 2) as increase_pct,
        s1."PHOTOSCOUNT" as before_photos,
        s2."PHOTOSCOUNT" as after_photos
      FROM property_sales s1
      JOIN property_sales s2 
        ON s1."UNPARSEDADDRESS" = s2."UNPARSEDADDRESS"
        AND s1.sale_order = 1 
        AND s2.sale_order = 2
      WHERE s1.total_sales >= 2
    )
    SELECT *
    FROM paired
    WHERE increase_pct BETWEEN ? AND ?
    ${minSqft ? 'AND sqft >= ?' : ''}
    ${maxSqft ? 'AND sqft <= ?' : ''}
    AND before_photos >= 3
    AND after_photos >= 3
    ORDER BY increase_pct DESC
    LIMIT ?
  `;
  
  binds.push(minPriceIncreasePct, maxPriceIncreasePct);
  if (minSqft) binds.push(minSqft);
  if (maxSqft) binds.push(maxSqft);
  binds.push(limit);
  
  return executeQuery(sql, binds);
}

// ============================================
// MULTICLASS-SPECIFIC FUNCTIONS
// ============================================

/**
 * Get unit types for a multi-family property
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Array>} - Unit type details
 */
async function getPropertyUnitTypes(listingKey) {
  const sql = `
    SELECT 
      "UNITTYPETYPE",
      "UNITTYPEDESCRIPTION",
      "UNITTYPEAREA",
      "UNITTYPEAREAUNIT",
      "UNITTYPEBEDSTOTAL",
      "UNITTYPEBATHSTOTAL",
      "UNITTYPEBATHSFULL",
      "UNITTYPEBATHSHALF",
      "UNITTYPEACTUALRENT",
      "UNITTYPEPROFORMA",
      "UNITTYPEUNITSTOTAL",
      "UNITTYPETOTALRENT",
      "UNITTYPEFURNISHED",
      "UNITTYPEGARAGESPACES",
      "UNITTYPEGARAGEATTACHEDYN",
      "order"
    FROM "PropertyUnitTypes"
    WHERE "LISTINGKEY" = ?
    ORDER BY "order" ASC
  `;
  return executeQuery(sql, [listingKey]);
}

/**
 * Get price/listing history for a property
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Array>} - Business history entries
 */
async function getPropertyBusinessHistory(listingKey) {
  const sql = `
    SELECT 
      "EFFECTIVETIMESTAMP",
      "PRICE",
      "STATUS",
      "MODIFICATIONTIMESTAMP"
    FROM "BusinessHistory"
    WHERE "LISTINGKEY" = ?
    ORDER BY "EFFECTIVETIMESTAMP" ASC
  `;
  return executeQuery(sql, [listingKey]);
}

/**
 * Get dynamic market list from actual data in Snowflake
 * @param {number} minListings - Minimum listings to include a city
 * @param {number} limit - Max cities to return
 * @returns {Promise<Array>} - Markets with counts
 */
async function getAvailableMarkets({ minListings = 5, limit = 100 } = {}) {
  const sql = `
    SELECT 
      "CITY",
      "STATEORPROVINCE",
      MIN("POSTALCODE") as "POSTALCODE",
      COUNT(*) as "LISTING_COUNT",
      COUNT(CASE WHEN "STANDARDSTATUS" = 'Active' THEN 1 END) as "ACTIVE_COUNT"
    FROM "Property"
    WHERE "CITY" IS NOT NULL 
    AND "STATEORPROVINCE" IS NOT NULL
    GROUP BY "CITY", "STATEORPROVINCE"
    HAVING COUNT(*) >= ?
    ORDER BY COUNT(*) DESC
    LIMIT ?
  `;
  return executeQuery(sql, [minListings, limit]);
}

/**
 * Get distinct property subtypes with counts
 * @param {string} propertyType - Optional filter by property type
 * @returns {Promise<Array>} - Subtypes with counts
 */
async function getPropertySubtypes(propertyType = null) {
  let sql = `
    SELECT "PROPERTYSUBTYPE", COUNT(*) as cnt
    FROM "Property"
    WHERE "PROPERTYSUBTYPE" IS NOT NULL
  `;
  const binds = [];
  if (propertyType) {
    sql += ` AND UPPER("PROPERTYTYPE") = UPPER(?)`;
    binds.push(propertyType);
  }
  sql += ` GROUP BY "PROPERTYSUBTYPE" ORDER BY cnt DESC`;
  return executeQuery(sql, binds);
}

/**
 * Get full property detail with all MultiClass fields
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Object|null>} - Full property record
 */
async function getMLSPropertyFullDetail(listingKey) {
  const sql = `SELECT * FROM "Property" WHERE "LISTINGKEY" = ? LIMIT 1`;
  const results = await executeQuery(sql, [listingKey]);
  if (!results[0]) return null;

  // Fetch all related data in parallel
  const [media, rooms, openHouses, unitTypes, history] = await Promise.all([
    getPropertyMedia(listingKey).catch(() => []),
    getPropertyRooms(listingKey).catch(() => []),
    getPropertyOpenHouses(listingKey).catch(() => []),
    getPropertyUnitTypes(listingKey).catch(() => []),
    getPropertyBusinessHistory(listingKey).catch(() => []),
  ]);

  const property = results[0];
  return {
    ...property,
    images: media.map(m => ({
      url: m.MEDIAURL,
      isPrimary: m.PREFERREDPHOTOYN === true,
      order: m.order,
      description: m.LONGDESCRIPTION || m.SHORTDESCRIPTION,
      width: m.IMAGEWIDTH,
      height: m.IMAGEHEIGHT
    })),
    rooms,
    openHouses,
    unitTypes,
    priceHistory: history,
  };
}

/**
 * Get distinct states with listing counts
 * @returns {Promise<Array>} - States with counts
 */
// Cache for expensive queries
let statesCache = null;
let statesCacheTime = 0;
const STATES_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getAvailableStates() {
  // Return cached result if fresh
  if (statesCache && (Date.now() - statesCacheTime) < STATES_CACHE_TTL) {
    return statesCache;
  }

  const sql = `
    SELECT "STATEORPROVINCE", COUNT(*) as cnt
    FROM "Property"
    WHERE "STATEORPROVINCE" IS NOT NULL
    GROUP BY "STATEORPROVINCE"
    ORDER BY cnt DESC
  `;
  const result = await executeQuery(sql);
  statesCache = result;
  statesCacheTime = Date.now();
  return result;
}

// ============================================
// HISTORICAL LISTING DATA FUNCTIONS
// ============================================

/**
 * Get all listings at the same address over time.
 * Links properties by street address + city + state, returns each listing
 * with key metrics, dates, and image counts.
 * @param {Object} params - { streetNumber, streetName, city, state, postalCode, parcelnumber }
 * @returns {Promise<Array>} - All listings at this address, chronologically
 */
async function getAddressListingHistory({ streetNumber, streetName, city, state, postalCode, parcelnumber }) {
  let whereClause = [];
  let binds = [];

  if (parcelnumber) {
    // Parcel number is the most reliable cross-listing identifier
    whereClause.push('"PARCELNUMBER" = ?');
    binds.push(parcelnumber);
  } else {
    // Fall back to address matching
    if (streetNumber) {
      whereClause.push('"STREETNUMBER" = ?');
      binds.push(streetNumber);
    }
    if (streetName) {
      whereClause.push('UPPER("STREETNAME") = UPPER(?)');
      binds.push(streetName);
    }
    if (city) {
      whereClause.push('UPPER("CITY") = UPPER(?)');
      binds.push(city);
    }
    if (state) {
      whereClause.push('UPPER("STATEORPROVINCE") = UPPER(?)');
      binds.push(state);
    }
  }

  if (whereClause.length === 0) return [];

  const sql = `
    SELECT 
      "LISTINGKEY",
      "LISTINGID",
      "LISTPRICE",
      "CLOSEPRICE",
      "ORIGINALLISTPRICE",
      "PREVIOUSLISTPRICE",
      "CURRENTPRICE",
      "PRICEPERSQUAREFOOT",
      "ONMARKETDATE",
      "CLOSEDATE",
      "LISTINGCONTRACTDATE",
      "OFFMARKETDATE",
      "PRICECHANGETIMESTAMP",
      "STATUSCHANGETIMESTAMP",
      "MODIFICATIONTIMESTAMP",
      "STANDARDSTATUS",
      "PREVIOUSSTANDARDSTATUS",
      "PROPERTYTYPE",
      "PROPERTYSUBTYPE",
      "BEDROOMSTOTAL",
      "BATHROOMSTOTALINTEGER",
      "LIVINGAREA",
      "LOTSIZEAREA",
      "YEARBUILT",
      "YEARBUILTEFFECTIVE",
      "DAYSONMARKET",
      "CUMULATIVEDAYSONMARKET",
      "PHOTOSCOUNT",
      "STREETNUMBER",
      "STREETNAME",
      "STREETSUFFIX",
      "CITY",
      "STATEORPROVINCE",
      "POSTALCODE",
      "PARCELNUMBER",
      "CAPRATE",
      "SOLDCAPRATE",
      "PROPERTYCONDITION",
      "IMPROVEMENTSAMOUNT",
      "IMPROVEMENTSDESCRIPTION",
      "PUBLICREMARKS",
      "LISTAGENTFULLNAME",
      "LISTOFFICENAME"
    FROM "Property"
    WHERE ${whereClause.join(' AND ')}
    ORDER BY COALESCE("ONMARKETDATE", "LISTINGCONTRACTDATE", "MODIFICATIONTIMESTAMP") ASC
  `;

  const listings = await executeQuery(sql, binds);

  // For each listing, get the primary image (with timeout)
  if (listings.length > 0) {
    try {
      const imgMap = await Promise.race([
        fetchPrimaryImages(listings.map(l => l.LISTINGKEY)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Image fetch timeout')), 8000))
      ]);
      listings.forEach(l => { l.primaryImage = imgMap[l.LISTINGKEY] || null; });
    } catch (e) {
      console.warn('[MLS] Historical image fetch skipped:', e.message);
      listings.forEach(l => { l.primaryImage = null; });
    }
  }

  return listings;
}

/**
 * Get all BusinessHistory price/status changes for a property.
 * This shows every price change, status change, etc. over the listing lifecycle.
 * @param {string} listingKey - The LISTINGKEY
 * @returns {Promise<Array>} - Timeline entries
 */
async function getPropertyPriceTimeline(listingKey) {
  const sql = `
    SELECT 
      "EFFECTIVETIMESTAMP",
      "PRICE",
      "STATUS",
      "MODIFICATIONTIMESTAMP"
    FROM "BusinessHistory"
    WHERE "LISTINGKEY" = ?
    ORDER BY "EFFECTIVETIMESTAMP" ASC
  `;
  return executeQuery(sql, [listingKey]);
}

/**
 * Get full price timeline for ALL listings at an address.
 * Merges BusinessHistory from multiple listing keys into one unified timeline.
 * @param {Object} params - { streetNumber, streetName, city, state }
 * @returns {Promise<Array>} - Unified timeline
 */
async function getAddressPriceTimeline({ streetNumber, streetName, city, state, parcelnumber }) {
  let addressFilter;
  let binds = [];

  if (parcelnumber) {
    addressFilter = '"PARCELNUMBER" = ?';
    binds.push(parcelnumber);
  } else {
    addressFilter = '"STREETNUMBER" = ? AND UPPER("STREETNAME") = UPPER(?) AND UPPER("CITY") = UPPER(?)';
    binds.push(streetNumber, streetName, city);
    if (state) {
      addressFilter += ' AND UPPER("STATEORPROVINCE") = UPPER(?)';
      binds.push(state);
    }
  }

  const sql = `
    SELECT 
      bh."LISTINGKEY",
      bh."EFFECTIVETIMESTAMP",
      bh."PRICE",
      bh."STATUS",
      p."LISTPRICE",
      p."CLOSEPRICE",
      p."ONMARKETDATE",
      p."CLOSEDATE"
    FROM "BusinessHistory" bh
    JOIN "Property" p ON bh."LISTINGKEY" = p."LISTINGKEY"
    WHERE ${addressFilter}
    ORDER BY bh."EFFECTIVETIMESTAMP" ASC
  `;
  return executeQuery(sql, binds);
}

/**
 * Search MLS listings with date-range filters for historical analysis.
 * Supports filtering by on-market date, close date, and includes
 * historical pricing columns.
 * @param {Object} filters - All search filters including date ranges
 * @returns {Promise<Array>} - Property listings
 */
async function searchHistoricalListings({
  city, state, zip,
  minPrice, maxPrice,
  minBeds, minBaths,
  propertyType,
  status,
  onMarketAfter, onMarketBefore,
  closedAfter, closedBefore,
  minPriceChange, // absolute $ change from original to close
  multiListingOnly, // only properties with multiple listings
  relistedOnly, // only properties relisted after a prior close
  minRelistGapDays = 180, // minimum days between close and next on-market
  limit = 50,
  offset = 0
}) {
  let whereClause = [];
  let binds = [];
  let joinBinds = [];

  if (city) { whereClause.push('UPPER(p."CITY") = UPPER(?)'); binds.push(city); }
  if (state) { whereClause.push('UPPER(p."STATEORPROVINCE") = UPPER(?)'); binds.push(state); }
  if (zip) { whereClause.push('p."POSTALCODE" = ?'); binds.push(zip); }
  if (minPrice) { whereClause.push('p."LISTPRICE" >= ?'); binds.push(minPrice); }
  if (maxPrice) { whereClause.push('p."LISTPRICE" <= ?'); binds.push(maxPrice); }
  if (minBeds) { whereClause.push('p."BEDROOMSTOTAL" >= ?'); binds.push(minBeds); }
  if (minBaths) { whereClause.push('p."BATHROOMSTOTALINTEGER" >= ?'); binds.push(minBaths); }
  if (propertyType) { whereClause.push('UPPER(p."PROPERTYTYPE") = UPPER(?)'); binds.push(propertyType); }
  if (status) { whereClause.push('UPPER(p."STANDARDSTATUS") = UPPER(?)'); binds.push(status); }
  if (onMarketAfter) { whereClause.push('p."ONMARKETDATE" >= ?'); binds.push(onMarketAfter); }
  if (onMarketBefore) { whereClause.push('p."ONMARKETDATE" <= ?'); binds.push(onMarketBefore); }
  if (closedAfter) { whereClause.push('p."CLOSEDATE" >= ?'); binds.push(closedAfter); }
  if (closedBefore) { whereClause.push('p."CLOSEDATE" <= ?'); binds.push(closedBefore); }

  // For multi-listing only: use a subquery to find addresses with 2+ listings
  let multiListingJoin = '';
  const useRelistFilter = !!relistedOnly || minRelistGapDays != null;
  if (multiListingOnly || relistedOnly) {
    if (useRelistFilter) {
      joinBinds.push(minRelistGapDays ?? 180);
      multiListingJoin = `
        JOIN (
          SELECT DISTINCT t."STREETNUMBER", t."STREETNAME", COALESCE(t."UNITNUMBER", '') AS "UNITNUMBER", t."CITY", t."STATEORPROVINCE"
          FROM (
            SELECT
              "STREETNUMBER",
              "STREETNAME",
              "UNITNUMBER",
              "CITY",
              "STATEORPROVINCE",
              "ONMARKETDATE",
              "CLOSEDATE",
              LAG("CLOSEDATE") OVER (
                PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
                ORDER BY "ONMARKETDATE"
              ) AS "PREV_CLOSEDATE"
            FROM "Property"
            WHERE "STREETNUMBER" IS NOT NULL
              AND "ONMARKETDATE" IS NOT NULL
          ) t
          WHERE t."PREV_CLOSEDATE" IS NOT NULL
            AND DATEDIFF('day', t."PREV_CLOSEDATE", t."ONMARKETDATE") >= ?
        ) ml ON p."STREETNUMBER" = ml."STREETNUMBER"
          AND p."STREETNAME" = ml."STREETNAME"
          AND COALESCE(p."UNITNUMBER", '') = ml."UNITNUMBER"
          AND p."CITY" = ml."CITY"
          AND p."STATEORPROVINCE" = ml."STATEORPROVINCE"
      `;
    } else {
      multiListingJoin = `
        JOIN (
          SELECT "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", '') AS "UNITNUMBER", "CITY", "STATEORPROVINCE"
          FROM "Property"
          WHERE "STREETNUMBER" IS NOT NULL
          GROUP BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          HAVING COUNT(*) > 1
        ) ml ON p."STREETNUMBER" = ml."STREETNUMBER" 
          AND p."STREETNAME" = ml."STREETNAME" 
          AND COALESCE(p."UNITNUMBER", '') = ml."UNITNUMBER"
          AND p."CITY" = ml."CITY" 
          AND p."STATEORPROVINCE" = ml."STATEORPROVINCE"
      `;
    }
  }

  const sql = `
    SELECT 
      p."LISTINGKEY",
      p."LISTINGID",
      p."LISTPRICE",
      p."CLOSEPRICE",
      p."ORIGINALLISTPRICE",
      p."PREVIOUSLISTPRICE",
      p."CURRENTPRICE",
      p."PRICEPERSQUAREFOOT",
      p."ONMARKETDATE",
      p."CLOSEDATE",
      p."LISTINGCONTRACTDATE",
      p."PRICECHANGETIMESTAMP",
      p."STANDARDSTATUS",
      p."PROPERTYTYPE",
      p."PROPERTYSUBTYPE",
      p."BEDROOMSTOTAL",
      p."BATHROOMSTOTALINTEGER",
      p."LIVINGAREA",
      p."YEARBUILT",
      p."DAYSONMARKET",
      p."CUMULATIVEDAYSONMARKET",
      p."PHOTOSCOUNT",
      p."STREETNUMBER",
      p."STREETNAME",
      p."STREETSUFFIX",
      p."UNITNUMBER",
      p."CITY",
      p."STATEORPROVINCE",
      p."POSTALCODE",
      p."PARCELNUMBER",
      p."CAPRATE",
      p."SOLDCAPRATE",
      p."PROPERTYCONDITION",
      p."IMPROVEMENTSAMOUNT",
      p."PUBLICREMARKS",
      p."LISTAGENTFULLNAME",
      p."LISTOFFICENAME",
      -- Count sibling listings at same address+unit
      COUNT(*) OVER (
        PARTITION BY p."STREETNUMBER", p."STREETNAME", COALESCE(p."UNITNUMBER", ''), p."CITY", p."STATEORPROVINCE"
      ) as "LISTING_COUNT_AT_ADDRESS"
    FROM "Property" p
    ${multiListingJoin}
    ${whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : ''}
    ORDER BY COALESCE(p."ONMARKETDATE", p."LISTINGCONTRACTDATE") DESC
    LIMIT ?
    OFFSET ?
  `;
  binds = [...joinBinds, ...binds, limit, offset];

  const properties = await executeQuery(sql, binds);

  // Attach primary images (with timeout)
  if (properties.length > 0) {
    try {
      const imgMap = await Promise.race([
        fetchPrimaryImages(properties.map(p => p.LISTINGKEY)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Image fetch timeout')), 8000))
      ]);
      properties.forEach(p => { p.primaryImage = imgMap[p.LISTINGKEY] || null; });
    } catch (e) {
      console.warn('[MLS] Property image fetch skipped:', e.message);
      properties.forEach(p => { p.primaryImage = null; });
    }
  }

  return properties;
}

/**
 * Get market-level price appreciation by year for a geographic area.
 * Used to normalize renovation gains vs. overall market appreciation.
 * @param {Object} params - { city, state, zip, propertyType }
 * @returns {Promise<Array>} - Year-over-year stats
 */
async function getMarketAppreciation({ city, state, zip, propertyType }) {
  let whereClause = ['"CLOSEPRICE" IS NOT NULL', '"CLOSEPRICE" > 0', '"CLOSEDATE" IS NOT NULL'];
  let binds = [];

  if (city) { whereClause.push('UPPER("CITY") = UPPER(?)'); binds.push(city); }
  if (state) { whereClause.push('UPPER("STATEORPROVINCE") = UPPER(?)'); binds.push(state); }
  if (zip) { whereClause.push('"POSTALCODE" = ?'); binds.push(zip); }
  if (propertyType) { whereClause.push('UPPER("PROPERTYTYPE") = UPPER(?)'); binds.push(propertyType); }

  const sql = `
    SELECT 
      YEAR("CLOSEDATE") as "YEAR",
      COUNT(*) as "SALES_COUNT",
      ROUND(AVG("CLOSEPRICE"), 0) as "AVG_CLOSE_PRICE",
      ROUND(MEDIAN("CLOSEPRICE"), 0) as "MEDIAN_CLOSE_PRICE",
      ROUND(AVG("PRICEPERSQUAREFOOT"), 2) as "AVG_PRICE_PER_SQFT",
      ROUND(AVG("DAYSONMARKET"), 0) as "AVG_DOM",
      ROUND(AVG("CLOSEPRICE" / NULLIF("LISTPRICE", 0) * 100), 1) as "AVG_SALE_TO_LIST_PCT"
    FROM "Property"
    WHERE ${whereClause.join(' AND ')}
    GROUP BY YEAR("CLOSEDATE")
    ORDER BY "YEAR"
  `;
  return executeQuery(sql, binds);
}

/**
 * Get market stats from truly comparable properties (similar beds, baths, sqft, age, type)
 * within the same zip code. Used for accurate mispricing detection and market appreciation.
 * 
 * @param {Object} params
 * @param {string} params.zip - ZIP code
 * @param {string} [params.state] - State
 * @param {string} [params.propertyType] - e.g. "Residential"
 * @param {number} [params.beds] - Target bedroom count (±1)
 * @param {number} [params.baths] - Target bath count (±1)
 * @param {number} [params.sqft] - Target sqft (±30%)
 * @param {number} [params.yearBuilt] - Target year built (±15 years)
 * @param {number} [params.saleYear] - Year to scope comparables to (±2 years)
 * @returns {Promise<Object>} - { medianPSF, avgPSF, medianPrice, avgPrice, sampleSize, filters }
 */
async function getComparableMarketStats({ zip, state, propertyType, beds, baths, sqft, yearBuilt, saleYear }) {
  const whereClause = [
    '"CLOSEPRICE" IS NOT NULL',
    '"CLOSEPRICE" > 0',
    '"CLOSEDATE" IS NOT NULL',
    '"LIVINGAREA" IS NOT NULL',
    '"LIVINGAREA" > 0',
    '"POSTALCODE" = ?'
  ];
  const binds = [zip];

  // Property type filter
  if (propertyType) {
    whereClause.push('UPPER("PROPERTYTYPE") = UPPER(?)');
    binds.push(propertyType);
  }

  // Filter out leases
  whereClause.push('UPPER("PROPERTYTYPE") NOT LIKE \'%LEASE%\'');

  // Bedrooms ± 1
  if (beds && beds > 0) {
    whereClause.push('"BEDROOMSTOTAL" BETWEEN ? AND ?');
    binds.push(Math.max(beds - 1, 0), beds + 1);
  }

  // Bathrooms ± 1
  if (baths && baths > 0) {
    whereClause.push('"BATHROOMSTOTALINTEGER" BETWEEN ? AND ?');
    binds.push(Math.max(baths - 1, 0), baths + 1);
  }

  // Square footage ± 30%
  if (sqft && sqft > 0) {
    const sqftLow = Math.round(sqft * 0.7);
    const sqftHigh = Math.round(sqft * 1.3);
    whereClause.push('"LIVINGAREA" BETWEEN ? AND ?');
    binds.push(sqftLow, sqftHigh);
  }

  // Year built ± 15 years
  if (yearBuilt && yearBuilt > 1800) {
    whereClause.push('"YEARBUILT" BETWEEN ? AND ?');
    binds.push(yearBuilt - 15, yearBuilt + 15);
  }

  // Sale year ± 2
  if (saleYear) {
    whereClause.push('YEAR("CLOSEDATE") BETWEEN ? AND ?');
    binds.push(saleYear - 2, saleYear + 2);
  }

  const sql = `
    SELECT 
      COUNT(*) as "SAMPLE_SIZE",
      ROUND(MEDIAN("CLOSEPRICE" / NULLIF("LIVINGAREA", 0)), 2) as "MEDIAN_PSF",
      ROUND(AVG("CLOSEPRICE" / NULLIF("LIVINGAREA", 0)), 2) as "AVG_PSF",
      ROUND(MEDIAN("CLOSEPRICE"), 0) as "MEDIAN_PRICE",
      ROUND(AVG("CLOSEPRICE"), 0) as "AVG_PRICE",
      ROUND(AVG("DAYSONMARKET"), 0) as "AVG_DOM",
      ROUND(AVG("CLOSEPRICE" / NULLIF("LISTPRICE", 0) * 100), 1) as "AVG_SALE_TO_LIST_PCT"
    FROM "Property"
    WHERE ${whereClause.join(' AND ')}
  `;

  const rows = await executeQuery(sql, binds);
  const row = rows?.[0] || {};
  const sampleSize = row.SAMPLE_SIZE || 0;

  // If too few comps with tight criteria, widen the search (drop sqft/year filters)
  if (sampleSize < 5 && (sqft || yearBuilt)) {
    console.log(`[getComparableMarketStats] Only ${sampleSize} tight comps for ${zip}, widening search...`);
    return getComparableMarketStats({ zip, state, propertyType, beds, baths, saleYear });
  }

  return {
    medianPSF: row.MEDIAN_PSF || 0,
    avgPSF: row.AVG_PSF || 0,
    medianPrice: row.MEDIAN_PRICE || 0,
    avgPrice: row.AVG_PRICE || 0,
    avgDOM: row.AVG_DOM || 0,
    avgSaleToListPct: row.AVG_SALE_TO_LIST_PCT || 0,
    sampleSize,
    filters: { zip, propertyType, beds, baths, sqft, yearBuilt, saleYear }
  };
}

/**
 * Find renovation before/after pairs in a single SQL query.
 * 
 * Does ALL filtering in Snowflake:
 *   - Same ZIP, same property type (Residential only, no leases)
 *   - Same address + unit (truly the same property)
 *   - Sold 2+ times since 2020
 *   - Close price > $50k (real sales only)
 *   - Price increased 5-500% between consecutive sales
 *   - Consecutive sales at least 60 days apart
 *   - Same sqft range (within 30%) and beds (within ±1)
 * 
 * Returns ready-to-use before/after pairs ordered by price increase %.
 *
 * @param {Object} params
 * @param {string} params.zip - ZIP code to search
 * @param {number} [params.limit=20] - Max pairs to return
 * @returns {Promise<Array>} - Array of { BEFORE_*, AFTER_*, ADDRESS, PRICE_INCREASE_PCT, ... }
 */
async function findRenovationPairs({ zip, limit = 20 }) {
  const sql = `
    WITH ranked_sales AS (
      SELECT
        "LISTINGKEY",
        "LISTINGID",
        "STREETNUMBER",
        "STREETNAME",
        "STREETSUFFIX",
        COALESCE("UNITNUMBER", '') AS "UNITNUMBER",
        "CITY",
        "STATEORPROVINCE",
        "POSTALCODE",
        "PROPERTYTYPE",
        "CLOSEPRICE",
        "LISTPRICE",
        "CLOSEDATE",
        "ONMARKETDATE",
        "LIVINGAREA",
        "BEDROOMSTOTAL",
        "BATHROOMSTOTALINTEGER",
        "YEARBUILT",
        "DAYSONMARKET",
        -- Previous sale at same address+unit
        LAG("LISTINGKEY") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_LISTINGKEY",
        LAG("CLOSEPRICE") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_CLOSEPRICE",
        LAG("LISTPRICE") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_LISTPRICE",
        LAG("CLOSEDATE") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_CLOSEDATE",
        LAG("ONMARKETDATE") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_ONMARKETDATE",
        LAG("LIVINGAREA") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_LIVINGAREA",
        LAG("BEDROOMSTOTAL") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_BEDROOMSTOTAL",
        LAG("BATHROOMSTOTALINTEGER") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_BATHROOMSTOTALINTEGER",
        LAG("YEARBUILT") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_YEARBUILT",
        LAG("DAYSONMARKET") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_DAYSONMARKET",
        "PUBLICREMARKS",
        LAG("PUBLICREMARKS") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("CLOSEDATE", "ONMARKETDATE")
        ) AS "PREV_PUBLICREMARKS"
      FROM "Property"
      WHERE "POSTALCODE" = ?
        AND "CLOSEPRICE" IS NOT NULL
        AND "CLOSEPRICE" > 50000
        AND "CLOSEDATE" >= '2020-01-01'
        AND "CLOSEDATE" IS NOT NULL
        AND UPPER(COALESCE("PROPERTYTYPE", '')) NOT LIKE '%LEASE%'
        AND UPPER(COALESCE("PROPERTYTYPE", '')) NOT LIKE '%RENTAL%'
        AND "STREETNUMBER" IS NOT NULL
        AND "STREETNAME" IS NOT NULL
    )
    SELECT
      -- Before (previous) sale
      "PREV_LISTINGKEY"           AS "BEFORE_LISTINGKEY",
      "PREV_CLOSEPRICE"           AS "BEFORE_PRICE",
      "PREV_LISTPRICE"            AS "BEFORE_LISTPRICE",
      "PREV_CLOSEDATE"            AS "BEFORE_DATE",
      "PREV_ONMARKETDATE"         AS "BEFORE_ONMARKETDATE",
      "PREV_LIVINGAREA"           AS "BEFORE_SQFT",
      "PREV_BEDROOMSTOTAL"        AS "BEFORE_BEDS",
      "PREV_BATHROOMSTOTALINTEGER" AS "BEFORE_BATHS",
      "PREV_YEARBUILT"            AS "BEFORE_YEARBUILT",
      "PREV_DAYSONMARKET"         AS "BEFORE_DOM",
      -- After (current) sale
      "LISTINGKEY"                AS "AFTER_LISTINGKEY",
      "CLOSEPRICE"                AS "AFTER_PRICE",
      "LISTPRICE"                 AS "AFTER_LISTPRICE",
      "CLOSEDATE"                 AS "AFTER_DATE",
      "ONMARKETDATE"              AS "AFTER_ONMARKETDATE",
      "LIVINGAREA"                AS "AFTER_SQFT",
      "BEDROOMSTOTAL"             AS "AFTER_BEDS",
      "BATHROOMSTOTALINTEGER"     AS "AFTER_BATHS",
      "DAYSONMARKET"              AS "AFTER_DOM",
      -- Property info
      "STREETNUMBER",
      "STREETNAME",
      "STREETSUFFIX",
      "UNITNUMBER",
      "CITY",
      "STATEORPROVINCE",
      "POSTALCODE",
      "PROPERTYTYPE",
      "YEARBUILT",
      "LIVINGAREA"                AS "SQFT",
      "BEDROOMSTOTAL"             AS "BEDS",
      "BATHROOMSTOTALINTEGER"     AS "BATHS",
      -- MLS Remarks (for material/feature extraction)
      "PREV_PUBLICREMARKS"       AS "BEFORE_REMARKS",
      "PUBLICREMARKS"            AS "AFTER_REMARKS",
      -- Computed fields
      ROUND(("CLOSEPRICE" - "PREV_CLOSEPRICE") / NULLIF("PREV_CLOSEPRICE", 0) * 100, 1) AS "PRICE_INCREASE_PCT",
      ("CLOSEPRICE" - "PREV_CLOSEPRICE") AS "PRICE_INCREASE_AMT",
      DATEDIFF('day', "PREV_CLOSEDATE", "CLOSEDATE") AS "DAYS_BETWEEN_SALES"
    FROM ranked_sales
    WHERE "PREV_LISTINGKEY" IS NOT NULL          -- has a previous sale
      AND "PREV_CLOSEPRICE" IS NOT NULL          -- previous sale had a price
      AND "PREV_CLOSEPRICE" > 50000              -- previous sale was real (not rental)
      -- Price increased 5-500%
      AND ("CLOSEPRICE" - "PREV_CLOSEPRICE") / NULLIF("PREV_CLOSEPRICE", 0) * 100 BETWEEN 5 AND 500
      -- At least 60 days between sales (not a same-day correction)
      AND DATEDIFF('day', "PREV_CLOSEDATE", "CLOSEDATE") >= 60
      -- Sqft within 30% (same property, not an addition/teardown)
      AND (
        "PREV_LIVINGAREA" IS NULL OR "LIVINGAREA" IS NULL
        OR (LEAST("PREV_LIVINGAREA", "LIVINGAREA") / NULLIF(GREATEST("PREV_LIVINGAREA", "LIVINGAREA"), 0) >= 0.70)
      )
      -- Beds within ±1
      AND (
        "PREV_BEDROOMSTOTAL" IS NULL OR "BEDROOMSTOTAL" IS NULL
        OR ABS("BEDROOMSTOTAL" - "PREV_BEDROOMSTOTAL") <= 1
      )
    ORDER BY "PRICE_INCREASE_PCT" DESC
    LIMIT ?
  `;

  console.log(`[findRenovationPairs] Searching ZIP ${zip} for before/after pairs...`);
  const rows = await executeQuery(sql, [zip, limit]);
  console.log(`[findRenovationPairs] Found ${rows.length} pairs in ZIP ${zip}`);
  return rows;
}

/**
 * Find lease/rental before/after pairs at the same address for rent-uplift analysis.
 *
 * Uses LISTPRICE as monthly asking rent proxy and looks for repeated listings
 * of the same address + unit over time.
 *
 * @param {Object} params
 * @param {string} params.zip - ZIP code to search
 * @param {number} [params.limit=100] - Max pairs to return
 * @returns {Promise<Array>}
 */
async function findRentalRenovationPairs({ zip, limit = 100 }) {
  const sql = `
    WITH ranked_leases AS (
      SELECT
        "LISTINGKEY",
        "STREETNUMBER",
        "STREETNAME",
        "STREETSUFFIX",
        COALESCE("UNITNUMBER", '') AS "UNITNUMBER",
        "CITY",
        "STATEORPROVINCE",
        "POSTALCODE",
        "PROPERTYTYPE",
        "PROPERTYSUBTYPE",
        "STANDARDSTATUS",
        "LISTPRICE",
        "CLOSEPRICE",
        "ONMARKETDATE",
        "OFFMARKETDATE",
        "LIVINGAREA",
        "BEDROOMSTOTAL",
        "BATHROOMSTOTALINTEGER",
        "YEARBUILT",
        LAG("LISTINGKEY") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("ONMARKETDATE", "OFFMARKETDATE")
        ) AS "PREV_LISTINGKEY",
        LAG("LISTPRICE") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("ONMARKETDATE", "OFFMARKETDATE")
        ) AS "PREV_LISTPRICE",
        LAG("ONMARKETDATE") OVER (
          PARTITION BY "STREETNUMBER", "STREETNAME", COALESCE("UNITNUMBER", ''), "CITY", "STATEORPROVINCE"
          ORDER BY COALESCE("ONMARKETDATE", "OFFMARKETDATE")
        ) AS "PREV_ONMARKETDATE"
      FROM "Property"
      WHERE "POSTALCODE" = ?
        AND "STREETNUMBER" IS NOT NULL
        AND "STREETNAME" IS NOT NULL
        AND "LISTPRICE" IS NOT NULL
        AND "LISTPRICE" BETWEEN 300 AND 20000
        AND ("CLOSEPRICE" IS NULL OR "CLOSEPRICE" < 25000)
        AND (
          UPPER(COALESCE("PROPERTYTYPE", '')) LIKE '%LEASE%'
          OR UPPER(COALESCE("PROPERTYTYPE", '')) LIKE '%RENT%'
          OR UPPER(COALESCE("PROPERTYSUBTYPE", '')) LIKE '%LEASE%'
          OR UPPER(COALESCE("PROPERTYSUBTYPE", '')) LIKE '%RENT%'
          OR UPPER(COALESCE("STANDARDSTATUS", '')) IN ('LEASED', 'RENTED')
        )
    )
    SELECT
      "PREV_LISTINGKEY" AS "BEFORE_LISTINGKEY",
      "LISTINGKEY" AS "AFTER_LISTINGKEY",
      "PREV_LISTPRICE" AS "BEFORE_RENT",
      "LISTPRICE" AS "AFTER_RENT",
      "PREV_ONMARKETDATE" AS "BEFORE_DATE",
      "ONMARKETDATE" AS "AFTER_DATE",
      "STREETNUMBER",
      "STREETNAME",
      "STREETSUFFIX",
      "UNITNUMBER",
      "CITY",
      "STATEORPROVINCE",
      "POSTALCODE",
      "PROPERTYTYPE",
      "LIVINGAREA" AS "SQFT",
      "BEDROOMSTOTAL" AS "BEDS",
      "BATHROOMSTOTALINTEGER" AS "BATHS",
      "YEARBUILT",
      ROUND(("LISTPRICE" - "PREV_LISTPRICE") / NULLIF("PREV_LISTPRICE", 0) * 100, 1) AS "RENT_INCREASE_PCT",
      DATEDIFF('day', "PREV_ONMARKETDATE", "ONMARKETDATE") AS "DAYS_BETWEEN_LISTINGS"
    FROM ranked_leases
    WHERE "PREV_LISTINGKEY" IS NOT NULL
      AND "PREV_LISTPRICE" IS NOT NULL
      AND "PREV_LISTPRICE" > 0
      AND "ONMARKETDATE" IS NOT NULL
      AND "PREV_ONMARKETDATE" IS NOT NULL
      AND DATEDIFF('day', "PREV_ONMARKETDATE", "ONMARKETDATE") >= 60
      AND ("LISTPRICE" - "PREV_LISTPRICE") / NULLIF("PREV_LISTPRICE", 0) * 100 BETWEEN -20 AND 200
    ORDER BY "RENT_INCREASE_PCT" DESC
    LIMIT ?
  `;

  console.log(`[findRentalRenovationPairs] Searching ZIP ${zip} for lease before/after pairs...`);
  const rows = await executeQuery(sql, [zip, limit]);
  console.log(`[findRentalRenovationPairs] Found ${rows.length} lease pairs in ZIP ${zip}`);
  return rows;
}

/**
 * Get all images for multiple listings (for before/after historical comparison).
 * Returns full image arrays grouped by listing key.
 * @param {string[]} listingKeys - Array of listing keys
 * @returns {Promise<Object>} - { listingKey: [images] }
 */

/**
 * Compute local cap rate for a ZIP code from actual MLS sale + lease data.
 * 
 * Matches median asking rent (from lease listings) with median sale price
 * (from recent closed sales) by bedroom count to produce bed-specific
 * and overall cap rates.
 * 
 * Cap rate = (annual rent) / (sale price) = (median_rent × 12) / median_sale_price
 * 
 * @param {Object} params
 * @param {string} params.zip - ZIP code
 * @param {string} [params.since='2023-01-01'] - Only consider sales/leases after this date
 * @returns {Promise<Object>} - { overall, byBeds: { 2: rate, 3: rate, ... }, sampleSizes }
 */
async function getLocalCapRate({ zip, since = '2023-01-01' } = {}) {
  const sql = `
    WITH lease_rents AS (
      SELECT
        "BEDROOMSTOTAL" AS beds,
        MEDIAN("LISTPRICE") AS median_rent,
        COUNT(*) AS lease_count
      FROM "Property"
      WHERE "POSTALCODE" = ?
        AND "LISTPRICE" IS NOT NULL
        AND "LISTPRICE" BETWEEN 500 AND 15000
        AND (
          UPPER(COALESCE("PROPERTYTYPE", '')) LIKE '%LEASE%'
          OR UPPER(COALESCE("PROPERTYTYPE", '')) LIKE '%RENT%'
          OR UPPER(COALESCE("PROPERTYSUBTYPE", '')) LIKE '%LEASE%'
          OR UPPER(COALESCE("PROPERTYSUBTYPE", '')) LIKE '%RENT%'
          OR UPPER(COALESCE("STANDARDSTATUS", '')) IN ('LEASED', 'RENTED')
        )
        AND "BEDROOMSTOTAL" IS NOT NULL
        AND "BEDROOMSTOTAL" BETWEEN 1 AND 7
        AND COALESCE("ONMARKETDATE", "OFFMARKETDATE") >= ?
      GROUP BY "BEDROOMSTOTAL"
      HAVING COUNT(*) >= 3
    ),
    sale_prices AS (
      SELECT
        "BEDROOMSTOTAL" AS beds,
        MEDIAN("CLOSEPRICE") AS median_price,
        COUNT(*) AS sale_count
      FROM "Property"
      WHERE "POSTALCODE" = ?
        AND "CLOSEPRICE" IS NOT NULL
        AND "CLOSEPRICE" > 50000
        AND "CLOSEDATE" >= ?
        AND UPPER(COALESCE("PROPERTYTYPE", '')) NOT LIKE '%LEASE%'
        AND UPPER(COALESCE("PROPERTYTYPE", '')) NOT LIKE '%RENT%'
        AND "BEDROOMSTOTAL" IS NOT NULL
        AND "BEDROOMSTOTAL" BETWEEN 1 AND 7
      GROUP BY "BEDROOMSTOTAL"
      HAVING COUNT(*) >= 3
    )
    SELECT
      l.beds,
      l.median_rent,
      s.median_price,
      l.lease_count,
      s.sale_count,
      ROUND((l.median_rent * 12) / NULLIF(s.median_price, 0) * 100, 2) AS cap_rate_pct
    FROM lease_rents l
    JOIN sale_prices s ON l.beds = s.beds
    ORDER BY l.beds
  `;

  console.log(`[getLocalCapRate] Computing cap rate for ZIP ${zip}...`);
  const rows = await executeQuery(sql, [zip, since, zip, since]);

  if (!rows || rows.length === 0) {
    console.log(`[getLocalCapRate] No matching lease+sale data for ZIP ${zip}`);
    return null;
  }

  const byBeds = {};
  const sampleSizes = {};
  let totalWeightedRate = 0;
  let totalWeight = 0;

  for (const row of rows) {
    const beds = row.BEDS || row.beds;
    const capRate = (row.CAP_RATE_PCT || row.cap_rate_pct) / 100; // Convert from pct to decimal
    const weight = Math.min(row.LEASE_COUNT || row.lease_count, row.SALE_COUNT || row.sale_count);

    byBeds[beds] = capRate;
    sampleSizes[beds] = { leases: row.LEASE_COUNT || row.lease_count, sales: row.SALE_COUNT || row.sale_count };
    totalWeightedRate += capRate * weight;
    totalWeight += weight;

    console.log(`[getLocalCapRate]   ${beds}BR: rent $${row.MEDIAN_RENT || row.median_rent}/mo, sale $${row.MEDIAN_PRICE || row.median_price} → cap rate ${(capRate * 100).toFixed(2)}% (${weight} samples)`);
  }

  const overall = totalWeight > 0 ? totalWeightedRate / totalWeight : null;
  console.log(`[getLocalCapRate] ZIP ${zip} overall cap rate: ${overall ? (overall * 100).toFixed(2) + '%' : 'N/A'} (${rows.length} bed-count buckets)`);

  return {
    zipCode: zip,
    overall,
    byBeds,
    sampleSizes,
    computedAt: new Date().toISOString()
  };
}

async function getHistoricalListingImages(listingKeys) {
  if (!listingKeys || listingKeys.length === 0) return {};

  const keys = listingKeys.map(k => `'${k.replace(/'/g, "''")}'`).join(',');
  const sql = `
    SELECT 
      "LISTINGKEY",
      "MEDIAURL",
      "PREFERREDPHOTOYN",
      "order",
      "LONGDESCRIPTION",
      "SHORTDESCRIPTION",
      "IMAGEWIDTH",
      "IMAGEHEIGHT",
      "IMAGEOF",
      "MEDIAMODIFICATIONTIMESTAMP"
    FROM "Media"
    WHERE "LISTINGKEY" IN (${keys})
    AND "MEDIACATEGORY" = 'Photo'
    ORDER BY "LISTINGKEY", "order" ASC
  `;
  const photos = await executeQuery(sql);

  const grouped = {};
  photos.forEach(p => {
    if (!grouped[p.LISTINGKEY]) grouped[p.LISTINGKEY] = [];
    grouped[p.LISTINGKEY].push({
      MEDIAURL: p.MEDIAURL,
      IMAGEOF: p.IMAGEOF,
      PREFERREDPHOTOYN: p.PREFERREDPHOTOYN === true,
      SHORTDESCRIPTION: p.SHORTDESCRIPTION || p.LONGDESCRIPTION,
      MEDIAMODIFICATIONTIMESTAMP: p.MEDIAMODIFICATIONTIMESTAMP,
      order: p.order
    });
  });
  return grouped;
}

export {
  connect,
  disconnect,
  executeQuery,
  executeQueryStream,
  searchProperties,
  searchPropertiesByLocation,
  searchPropertiesByPrice,
  searchPropertiesInBounds,
  getPropertyById,
  getPropertyByAddress,
  getPropertyCount,
  testConnection,
  listTables,
  describeTable,
  // MLS-specific functions
  searchMLSProperties,
  searchMLSPropertiesWithImages,
  getMLSPropertyByKey,
  getMLSPropertyWithImages,
  getPropertyMedia,
  getPropertyOpenHouses,
  getPropertyRooms,
  // MultiClass functions
  getPropertyUnitTypes,
  getPropertyBusinessHistory,
  getAvailableMarkets,
  getPropertySubtypes,
  getMLSPropertyFullDetail,
  getAvailableStates,
  // Renovation ROI functions
  findRenovationCandidates,
  getPhotosForListings,
  getRenovationCandidateWithPhotos,
  getRenovationAreaStats,
  findSimilarRenovations,
  // Historical listing functions
  getAddressListingHistory,
  getPropertyPriceTimeline,
  getAddressPriceTimeline,
  searchHistoricalListings,
  getMarketAppreciation,
  getComparableMarketStats,
  findRenovationPairs,
  findRentalRenovationPairs,
  getLocalCapRate,
  getHistoricalListingImages,
};

export default {
  connect,
  disconnect,
  executeQuery,
  executeQueryStream,
  searchProperties,
  searchPropertiesByLocation,
  searchPropertiesByPrice,
  searchPropertiesInBounds,
  getPropertyById,
  getPropertyByAddress,
  getPropertyCount,
  testConnection,
  listTables,
  describeTable,
  // MLS-specific functions
  searchMLSProperties,
  searchMLSPropertiesWithImages,
  getMLSPropertyByKey,
  getMLSPropertyWithImages,
  getPropertyMedia,
  getPropertyOpenHouses,
  getPropertyRooms,
  // MultiClass functions
  getPropertyUnitTypes,
  getPropertyBusinessHistory,
  getAvailableMarkets,
  getPropertySubtypes,
  getMLSPropertyFullDetail,
  getAvailableStates,
  // Renovation ROI functions
  findRenovationCandidates,
  getPhotosForListings,
  getRenovationCandidateWithPhotos,
  getRenovationAreaStats,
  findSimilarRenovations,
  // Historical listing functions
  getAddressListingHistory,
  getPropertyPriceTimeline,
  getAddressPriceTimeline,
  searchHistoricalListings,
  getMarketAppreciation,
  getComparableMarketStats,
  findRenovationPairs,
  findRentalRenovationPairs,
  getLocalCapRate,
  getHistoricalListingImages,
};
