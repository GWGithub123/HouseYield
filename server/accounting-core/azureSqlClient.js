import 'dotenv/config';

export function getAzureSqlConfig() {
  return {
    server: process.env.AZURE_SQL_SERVER || '',
    database: process.env.AZURE_SQL_DATABASE || '',
    user: process.env.AZURE_SQL_USER || '',
    password: process.env.AZURE_SQL_PASSWORD || '',
    port: Number(process.env.AZURE_SQL_PORT || 1433),
    connectionTimeout: Number(process.env.AZURE_SQL_CONNECTION_TIMEOUT_MS || 30000),
    requestTimeout: Number(process.env.AZURE_SQL_REQUEST_TIMEOUT_MS || 30000),
    options: {
      encrypt: true,
      trustServerCertificate: false
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  };
}

export function isAzureSqlConfigured() {
  const config = getAzureSqlConfig();
  return Boolean(config.server && config.database && config.user && config.password);
}

export function splitAzureSqlBatches(sqlText = '') {
  return String(sqlText)
    .split(/^\s*GO\s*$/gim)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function getAzureSqlModule() {
  const sqlModule = await import('mssql');
  return sqlModule.default || sqlModule;
}

let poolPromise = null;

export async function getAzureSqlPool() {
  if (!isAzureSqlConfigured()) {
    throw new Error('Azure SQL is not configured. Set AZURE_SQL_SERVER, AZURE_SQL_DATABASE, AZURE_SQL_USER, and AZURE_SQL_PASSWORD.');
  }

  if (!poolPromise) {
    poolPromise = (async () => {
      const sql = await getAzureSqlModule();
      const pool = new sql.ConnectionPool(getAzureSqlConfig());
      await pool.connect();
      return pool;
    })();
  }

  return poolPromise;
}

export async function pingAzureSql() {
  const pool = await getAzureSqlPool();
  const result = await pool.request().query('SELECT DB_NAME() AS databaseName, SYSUTCDATETIME() AS serverTimeUtc');
  return result.recordset?.[0] || null;
}

export async function runAzureSqlBatches(sqlText) {
  const pool = await getAzureSqlPool();
  const statements = splitAzureSqlBatches(sqlText);

  for (const statement of statements) {
    await pool.request().batch(statement);
  }

  return statements.length;
}