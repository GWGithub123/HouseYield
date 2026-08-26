import { getAzureSqlConfig, isAzureSqlConfigured, pingAzureSql } from './azureSqlClient.js';

async function main() {
  const config = getAzureSqlConfig();

  if (!isAzureSqlConfigured()) {
    console.log(JSON.stringify({
      ok: true,
      status: 'not_configured',
      configured: false,
      connected: false,
      server: config.server || null,
      database: config.database || null
    }, null, 2));
    return;
  }

  try {
    const ping = await pingAzureSql();
    console.log(JSON.stringify({
      ok: true,
      status: 'healthy',
      configured: true,
      connected: true,
      server: config.server,
      database: ping?.databaseName || config.database,
      serverTimeUtc: ping?.serverTimeUtc || null
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      status: 'unreachable',
      configured: true,
      connected: false,
      server: config.server,
      database: config.database,
      error: error.message
    }, null, 2));
    process.exitCode = 1;
  }
}

main();