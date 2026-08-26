import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildBankTransactionJournalPayload,
  buildBookkeepingReclassificationShadowCandidate,
  buildBookkeepingShadowCandidate
} from './bookkeeping-firestore.js';
import { buildJournalDraftFromFinanceEvent } from './accounting-core/postingEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixtureDir = path.join(__dirname, 'accounting-fixtures');

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((accumulator, key) => {
        accumulator[key] = sortObject(value[key]);
        return accumulator;
      }, {});
  }

  return value;
}

function findFirstDifference(expected, actual, currentPath = 'root') {
  if (typeof expected !== typeof actual) {
    return `${currentPath}: expected ${typeof expected}, received ${typeof actual}`;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${currentPath}: expected array length ${expected.length}, received ${actual.length}`;
    }

    for (let index = 0; index < expected.length; index += 1) {
      const difference = findFirstDifference(expected[index], actual[index], `${currentPath}[${index}]`);
      if (difference) {
        return difference;
      }
    }

    return null;
  }

  if (expected && typeof expected === 'object' && actual && typeof actual === 'object') {
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();

    if (expectedKeys.join('|') !== actualKeys.join('|')) {
      return `${currentPath}: expected keys ${expectedKeys.join(', ')}, received ${actualKeys.join(', ')}`;
    }

    for (const key of expectedKeys) {
      const difference = findFirstDifference(expected[key], actual[key], `${currentPath}.${key}`);
      if (difference) {
        return difference;
      }
    }

    return null;
  }

  return expected === actual ? null : `${currentPath}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`;
}

function buildJournalEntrySnapshot(testCase) {
  const candidate = buildBookkeepingShadowCandidate(testCase.userId, testCase.journalEntryId, testCase.entry);
  const draft = candidate.ok ? buildJournalDraftFromFinanceEvent(candidate.financeEventInput) : null;

  return {
    label: testCase.label,
    candidate,
    draft: draft
      ? {
          financeEventType: draft.journalEntry.financeEventType,
          sourceRef: draft.journalEntry.sourceRef,
          lines: draft.journalEntry.lines
        }
      : null
  };
}

function buildReclassificationSnapshot(testCase) {
  const candidate = buildBookkeepingReclassificationShadowCandidate(
    testCase.userId,
    testCase.entryId,
    testCase.previousEntry,
    testCase.nextEntry
  );
  const draft = candidate.ok ? buildJournalDraftFromFinanceEvent(candidate.financeEventInput) : null;

  return {
    label: testCase.label,
    candidate,
    draft: draft
      ? {
          financeEventType: draft.journalEntry.financeEventType,
          sourceRef: draft.journalEntry.sourceRef,
          lines: draft.journalEntry.lines
        }
      : null
  };
}

function buildBankTransactionSnapshot(testCase) {
  return {
    label: testCase.label,
    payload: buildBankTransactionJournalPayload(testCase.txn, testCase.categoryAccountName || null)
  };
}

function buildExpectedOutputs(fixture) {
  const bankTransactionCases = (fixture.bankTransactionCases || []).map(buildBankTransactionSnapshot);
  const journalEntryCases = (fixture.journalEntryCases || []).map(buildJournalEntrySnapshot);
  const reclassificationCases = (fixture.reclassificationCases || []).map(buildReclassificationSnapshot);

  return sortObject({
    fixtureName: fixture.fixtureName,
    summary: {
      bankTransactionCaseCount: bankTransactionCases.length,
      journalEntryCaseCount: journalEntryCases.length,
      reclassificationCaseCount: reclassificationCases.length
    },
    bankTransactionCases,
    journalEntryCases,
    reclassificationCases
  });
}

function main() {
  const args = process.argv.slice(2);
  const fixtureName = args.find((arg) => !arg.startsWith('--')) || 'bookkeeping-shadow-paths';
  const shouldWriteExpected = args.includes('--write-expected');
  const fixturePath = path.join(fixtureDir, `${fixtureName}.fixture.json`);
  const expectedPath = path.join(fixtureDir, `${fixtureName}.expected.json`);
  const actualPath = path.join(fixtureDir, `${fixtureName}.actual.json`);

  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }

  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const actual = buildExpectedOutputs(fixture);

  if (shouldWriteExpected) {
    fs.writeFileSync(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`Wrote expected snapshot: ${expectedPath}`);
    return;
  }

  if (!fs.existsSync(expectedPath)) {
    throw new Error(`Expected snapshot not found: ${expectedPath}. Run with --write-expected first.`);
  }

  const expected = sortObject(JSON.parse(fs.readFileSync(expectedPath, 'utf8')));
  const difference = findFirstDifference(expected, actual);

  if (difference) {
    fs.writeFileSync(actualPath, `${JSON.stringify(actual, null, 2)}\n`);
    console.error(`Bookkeeping shadow fixture mismatch: ${difference}`);
    console.error(`Wrote actual snapshot: ${actualPath}`);
    process.exit(1);
  }

  console.log(`Bookkeeping shadow fixture passed: ${fixtureName}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}