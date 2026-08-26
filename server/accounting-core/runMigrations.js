import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { getAzureSqlPool, isAzureSqlConfigured, runAzureSqlBatches } from './azureSqlClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, 'sql');

async function ensureMigrationTable(pool) {
  await pool.request().batch(`
    IF NOT EXISTS (
      SELECT 1
      FROM sys.tables t
      INNER JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'dbo' AND t.name = 'schema_migrations'
    )
    BEGIN
      CREATE TABLE dbo.schema_migrations (
        migration_name NVARCHAR(255) NOT NULL PRIMARY KEY,
        migration_checksum NVARCHAR(64) NOT NULL,
        applied_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
      );
    END
  `);
}

async function getAppliedMigrations(pool) {
  const result = await pool.request().query(`
    SELECT migration_name, migration_checksum, applied_at
    FROM dbo.schema_migrations
    ORDER BY migration_name ASC
  `);
  return new Map(result.recordset.map((row) => [row.migration_name, row]));
}

function buildChecksum(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function main() {
  if (!isAzureSqlConfigured()) {
    console.error('Azure SQL is not configured. Set AZURE_SQL_SERVER, AZURE_SQL_DATABASE, AZURE_SQL_USER, and AZURE_SQL_PASSWORD before running migrations.');
    process.exit(1);
  }

  const pool = await getAzureSqlPool();
  await ensureMigrationTable(pool);

  const migrationFiles = (await fs.readdir(migrationsDir))
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right));

  const appliedMigrations = await getAppliedMigrations(pool);
  const appliedNow = [];
  const skipped = [];

  for (const fileName of migrationFiles) {
    const filePath = path.join(migrationsDir, fileName);
    const migrationSql = await fs.readFile(filePath, 'utf8');
    const checksum = buildChecksum(migrationSql);
    const existingMigration = appliedMigrations.get(fileName);

    if (existingMigration) {
      if (existingMigration.migration_checksum !== checksum) {
        throw new Error(`Migration ${fileName} was already applied with a different checksum. Create a new migration file instead of modifying applied SQL.`);
      }

      skipped.push(fileName);
      continue;
    }

    const batchCount = await runAzureSqlBatches(migrationSql);
    await pool.request()
      .input('migrationName', fileName)
      .input('migrationChecksum', checksum)
      .query(`
        INSERT INTO dbo.schema_migrations (migration_name, migration_checksum)
        VALUES (@migrationName, @migrationChecksum)
      `);

    appliedNow.push({ fileName, batchCount });
  }

  console.log(JSON.stringify({
    ok: true,
    appliedNow,
    skipped,
    totalMigrations: migrationFiles.length
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});