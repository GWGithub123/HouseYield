import { syncTaxRulesetToAzure } from './taxRulesetStore.js';

function parseArgs(args) {
  const options = {
    taxYear: undefined,
    approvalStatus: undefined,
    approvedBy: undefined
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--year' && args[index + 1]) {
      options.taxYear = Number(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--approval-status' && args[index + 1]) {
      options.approvalStatus = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--approved-by' && args[index + 1]) {
      options.approvedBy = args[index + 1];
      index += 1;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await syncTaxRulesetToAzure(options);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});