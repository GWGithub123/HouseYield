import 'dotenv/config';
import { getAzureSqlPool } from './azureSqlClient.js';

const pool = await getAzureSqlPool();
const result = await pool.request().query(`
  SELECT
    DB_NAME() AS databaseName,
    CAST(DATABASEPROPERTYEX(DB_NAME(), 'ServiceObjective') AS NVARCHAR(128)) AS serviceObjective,
    CAST(DATABASEPROPERTYEX(DB_NAME(), 'Edition') AS NVARCHAR(128)) AS edition,
    CAST(DATABASEPROPERTYEX(DB_NAME(), 'MaxSizeInBytes') AS BIGINT) AS maxSizeInBytes
`);
console.log(JSON.stringify(result.recordset[0], null, 2));
