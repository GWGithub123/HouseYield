import 'dotenv/config';

import { runAssistantWeeklyDigestBatch } from './services/assistantWeeklyDigestService.js';

function parseArguments(argv = []) {
  const options = {
    dryRun: false,
    force: false,
    limit: undefined,
    userId: '',
    reason: 'cli',
  };

  for (const arg of argv) {
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      const parsed = Number.parseInt(arg.split('=')[1] || '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        options.limit = parsed;
      }
      continue;
    }
    if (arg.startsWith('--user-id=')) {
      options.userId = arg.split('=')[1] || '';
      continue;
    }
    if (arg.startsWith('--reason=')) {
      options.reason = arg.split('=')[1] || options.reason;
    }
  }

  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const summary = await runAssistantWeeklyDigestBatch(options);
  console.log(JSON.stringify(summary, null, 2));

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[WeeklyDigestBatch] Failed:', error);
  process.exit(1);
});